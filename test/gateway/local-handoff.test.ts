import { describe, expect, test } from "bun:test";

const KEY = String(Math.random());

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

function spawnProxy(port: number, remote: string, instance: string) {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/local-proc.ts", import.meta.url).pathname], {
    env: { ...process.env, TEST_PORT: String(port), TEST_REMOTE: remote, TEST_INSTANCE: instance, TEST_KEY: KEY },
    stdout: "pipe",
    stderr: "pipe",
  });
  return child;
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting");
}

const statusInstance = async (port: number): Promise<string | undefined> => {
  const r = await fetch(`http://127.0.0.1:${port}/__ais/status`, { headers: { connection: "close" } });
  return ((await r.json()) as { instance?: string }).instance;
};

describe("restart handoff with real processes", () => {
  test("a long stream finishes across a handoff and the port never refuses a connection", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode("first;"));
              await gate;
              c.enqueue(new TextEncoder().encode("last"));
              c.close();
            },
          }),
        ),
    });
    const port = await freePort();
    const remote = `http://127.0.0.1:${upstream.port}`;
    const a = spawnProxy(port, remote, "a");
    let b: ReturnType<typeof spawnProxy> | undefined;
    try {
      await waitFor(async () => (await statusInstance(port)) === "a");
      const res = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, { method: "POST", body: "{}", headers: { "x-api-key": KEY } });
      const reader = res.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first;");

      // Slot b starts and shares the port; wait until it answers.
      b = spawnProxy(port, remote, "b");
      await waitFor(async () => {
        for (let i = 0; i < 30; i++) if ((await statusInstance(port)) === "b") return true;
        return false;
      });

      // Probe continuously with fresh connections while a is told to drain.
      const errors: string[] = [];
      let probes = 0;
      let probing = true;
      const prober = (async () => {
        while (probing) {
          try {
            await statusInstance(port);
          } catch (err) {
            errors.push(String((err as { code?: string }).code ?? err));
          }
          probes++;
          await Bun.sleep(3);
        }
      })();
      await Bun.sleep(100);
      a.kill("SIGTERM");
      await Bun.sleep(500);
      expect(a.exitCode).toBeNull();
      // New connections keep working with a draining.
      expect(await statusInstance(port)).toBe("b");

      release();
      let rest = "";
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        rest += new TextDecoder().decode(r.value);
      }
      expect(rest).toBe("last");
      expect(await a.exited).toBe(0);
      await Bun.sleep(100);
      probing = false;
      await prober;
      expect(probes).toBeGreaterThan(50);
      expect(errors.filter((e) => /ECONNREFUSED|ConnectionRefused/.test(e))).toEqual([]);
      // Closing a SO_REUSEPORT listener can reset a connection that was still in its accept queue at that instant (measured: rare, at most one).
      // That is a reset, not a refusal; clients retry it. Anything else, or more than one, fails the test.
      expect(errors.filter((e) => e !== "ECONNRESET")).toEqual([]);
      expect(errors.length).toBeLessThanOrEqual(1);
    } finally {
      a.kill("SIGKILL");
      b?.kill("SIGKILL");
      upstream.stop(true);
    }
  }, 60_000);

  test("a second SIGTERM forces the draining process to exit", async () => {
    const gate = new Promise<void>(() => {});
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: () => new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode("x")); await gate; } })) });
    const port = await freePort();
    const a = spawnProxy(port, `http://127.0.0.1:${upstream.port}`, "a");
    try {
      await waitFor(async () => (await statusInstance(port)) === "a");
      const res = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, { method: "POST", body: "{}", headers: { "x-api-key": KEY } });
      await res.body!.getReader().read();
      a.kill("SIGTERM");
      await Bun.sleep(300);
      expect(a.exitCode).toBeNull();
      a.kill("SIGTERM");
      expect(await a.exited).toBe(1);
    } finally {
      a.kill("SIGKILL");
      upstream.stop(true);
    }
  }, 30_000);
});
