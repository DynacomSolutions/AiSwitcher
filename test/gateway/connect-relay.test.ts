import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { parseUpstreams, startConnectRelay, type ConnectRelay } from "../../src/gateway/connect-relay.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A TCP server that answers "<tag>:<what it got>" and counts its connections. */
async function tagServer(tag: string, port = 0): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const srv = net.createServer((s) => {
    hits += 1;
    s.on("data", (d) => s.end(`${tag}:${d.toString()}`));
  });
  await new Promise<void>((r) => srv.listen({ host: "127.0.0.1", port }, () => r()));
  cleanups.push(() => srv.close());
  return { port: (srv.address() as net.AddressInfo).port, hits: () => hits };
}

/** A port nothing listens on (connect is refused at once). */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen({ host: "127.0.0.1", port: 0 }, () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function ask(relay: ConnectRelay, msg: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect({ host: "127.0.0.1", port: relay.port });
    let got = "";
    c.on("connect", () => c.write(msg));
    c.on("data", (d) => (got += d.toString()));
    c.on("close", () => resolve(got));
    c.on("error", () => resolve(got));
  });
}

async function relay(opts: Partial<Parameters<typeof startConnectRelay>[0]> & { upstreams: Parameters<typeof startConnectRelay>[0]["upstreams"] }, logs: string[] = []): Promise<ConnectRelay> {
  const r = await startConnectRelay({ port: 0, connectTimeoutMs: 300, log: (l) => logs.push(l), lookup: async () => [], ownAddresses: () => [], ...opts });
  cleanups.push(() => r.stop());
  return r;
}

describe("parseUpstreams", () => {
  test("reads host:port lists, IPv6 in brackets, and refuses an entry without a port", () => {
    expect(parseUpstreams("192.0.2.10:47132, gw.example:47132\n[fd00::1]:9")).toEqual([
      { host: "192.0.2.10", port: 47132 },
      { host: "gw.example", port: 47132 },
      { host: "fd00::1", port: 9 },
    ]);
    expect(() => parseUpstreams("gw.example")).toThrow();
    expect(() => parseUpstreams("gw.example:0")).toThrow();
  });
});

describe("connect relay", () => {
  test("skips a refused upstream and pipes bytes both ways through the next one", async () => {
    const dead = await freePort();
    const live = await tagServer("live");
    const logs: string[] = [];
    const r = await relay({ upstreams: [{ host: "127.0.0.2", port: dead }, { host: "127.0.0.1", port: live.port }] }, logs);
    expect(await ask(r, "CONNECT api.example:443")).toBe("live:CONNECT api.example:443");
    expect(logs.some((l) => l.includes("unreachable"))).toBe(true);
    expect(logs).toContain(`connect relay: via 127.0.0.1:${live.port}`);
  });

  test("a failed upstream is skipped for deadMs, then tried again", async () => {
    let t = 1_000;
    const port = await freePort();
    const backup = await tagServer("backup");
    const r = await relay({ now: () => t, deadMs: 30_000, upstreams: [{ host: "127.0.0.1", port }, { host: "127.0.0.1", port: backup.port }] });
    expect(await ask(r, "a")).toBe("backup:a");
    // The first upstream comes back, but it is still marked dead: the next connection goes straight to the backup.
    const back = await tagServer("first", port);
    expect(await ask(r, "b")).toBe("backup:b");
    expect(back.hits()).toBe(0);
    t += 30_001;
    expect(await ask(r, "c")).toBe("first:c");
  });

  test("a host name expands to all its addresses, this host's own address first", async () => {
    const live = await tagServer("own");
    const logs: string[] = [];
    // 192.0.2.1 (TEST-NET) is first in DNS order and would time out; the own address must be tried before it.
    const r = await relay({ upstreams: [{ host: "gw.example", port: live.port }], lookup: async () => ["192.0.2.1", "127.0.0.1"], ownAddresses: () => ["127.0.0.1"] }, logs);
    expect(await ask(r, "x")).toBe("own:x");
    expect(logs.some((l) => l.includes("192.0.2.1"))).toBe(false);
  });

  test("keeps the last good resolution when DNS fails", async () => {
    let t = 0;
    let fail = false;
    const live = await tagServer("cached");
    const r = await relay({
      now: () => t,
      resolveMs: 10,
      upstreams: [{ host: "gw.example", port: live.port }],
      lookup: async () => {
        if (fail) throw Object.assign(new Error("dns down"), { code: "EAI_AGAIN" });
        return ["127.0.0.1"];
      },
    });
    expect(await ask(r, "1")).toBe("cached:1");
    fail = true;
    t += 1_000;
    expect(await ask(r, "2")).toBe("cached:2");
  });

  test("closes the client when no upstream answers", async () => {
    const logs: string[] = [];
    const r = await relay({ upstreams: [{ host: "127.0.0.1", port: await freePort() }] }, logs);
    expect(await ask(r, "x")).toBe("");
    expect(logs).toContain("connect relay: no upstream reachable; connection closed");
  });

  test("refuses an upstream that is the relay itself", async () => {
    await expect(startConnectRelay({ port: 47197, upstreams: [{ host: "127.0.0.1", port: 47197 }], log: () => {} })).rejects.toThrow("no usable upstream");
  });
});
