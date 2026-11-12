import { afterAll, describe, expect, test } from "bun:test";
import { SQL, type Subprocess } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgHomeStore, parseStoreKey } from "../../src/gateway/home-store.ts";
import { migrate, PgGatewayStore } from "../../src/gateway/pg-store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";

/**
 * Two gateway processes on one PostgreSQL, logins only in the credential store (no host files): a concurrent refresh
 * rotates the grant once, both replicas serve, a browser call crosses replicas, and with one replica killed the other
 * keeps serving and refreshing.
 */

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";
const ROOT = join(import.meta.dir, "..", "..");
const ADMIN = "SYNTHETIC_FIXTURE-admin-token-0123456789abcdef0123";
const KEY = Buffer.alloc(32, 7).toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The child processes run like production: without the test preload's member-store switch. */
const childEnv = (extra: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "AIS_GATEWAY_MEMBER_STORE" && k !== "AIS_HOST_HOME") env[k] = v;
  return { ...env, ...extra };
};

if (!url && process.env.CI && !optOut) {
  test("gateway HA tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("gateway HA tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  /** The provider: rotates the refresh token on every refresh and refuses a reused one, like Anthropic does. */
  const provider = {
    n: 0,
    access: "SYNTHETIC_FIXTURE-access-0",
    refresh: "SYNTHETIC_FIXTURE-refresh-0",
    rejectedAccess: new Set<string>(),
    rotations: 0,
    reused: 0,
  };
  const fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/token") {
        const text = await req.text();
        let rt: string | undefined;
        try {
          rt = (JSON.parse(text) as { refresh_token?: string }).refresh_token;
        } catch {
          rt = new URLSearchParams(text).get("refresh_token") ?? undefined;
        }
        if (rt !== provider.refresh) {
          provider.reused += 1;
          return Response.json({ error: "invalid_grant", error_description: "refresh token reused" }, { status: 400 });
        }
        await sleep(150); // a slow token endpoint widens the race window
        provider.n += 1;
        provider.rotations += 1;
        provider.access = `SYNTHETIC_FIXTURE-access-${provider.n}`;
        provider.refresh = `SYNTHETIC_FIXTURE-refresh-${provider.n}`;
        return Response.json({ access_token: provider.access, refresh_token: provider.refresh, expires_in: 30 * 86_400, token_type: "Bearer" });
      }
      const auth = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? req.headers.get("x-api-key") ?? "";
      if (auth !== provider.access || provider.rejectedAccess.has(auth)) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid token" } }, { status: 401 });
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });

  const dirs: string[] = [];
  const procs: Subprocess[] = [];
  afterAll(async () => {
    for (const p of procs) p.kill("SIGKILL");
    fake.stop(true);
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const freePort = (): number => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const p = s.port as number;
    s.stop(true);
    return p;
  };

  async function startReplica(home: string): Promise<{ proc: Subprocess; port: number; adminPort: number }> {
    const adminPort = freePort();
    const proc = Bun.spawn(["bun", join(ROOT, "test/gateway/fixtures/ha-replica.ts")], {
      cwd: ROOT,
      env: childEnv({ HOME: home, HA_FAKE_PROVIDER: `http://127.0.0.1:${fake.port}`, HA_DATABASE_URL: url!, HA_ADMIN_TOKEN: ADMIN, HA_ADMIN_PORT: String(adminPort), AIS_GATEWAY_STORE_KEY: KEY, AIS_GATEWAY_PUBLIC_HOSTS: "" }),
      stdout: "pipe",
      stderr: "inherit",
    });
    procs.push(proc);
    const reader = proc.stdout.getReader();
    let buf = "";
    const deadline = Date.now() + 20_000;
    while (!buf.includes("\n")) {
      if (Date.now() > deadline) throw new Error("replica did not start");
      const { value, done } = await reader.read();
      if (done) throw new Error("replica exited");
      buf += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const line = buf.split("\n").find((l) => l.startsWith("{"))!;
    const { port } = JSON.parse(line) as { port: number };
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => undefined);
      if (r?.status === 200) return { proc, port, adminPort };
      await sleep(200);
    }
    throw new Error("replica never became ready");
  }

  const ask = (port: number, token: string) =>
    fetch(`http://127.0.0.1:${port}/ha-app/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-test", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });

  describe("gateway replicas on the PostgreSQL credential store", () => {
    test("import, concurrent refresh rotates once, both serve, browser across replicas, one killed", async () => {
      await migrate(url);
      const admin = new SQL(url);
      await admin`DELETE FROM gateway_home_files`;
      await admin`DELETE FROM gateway_refresh_journal`;
      await admin`DELETE FROM gateway_browser_presence`.catch(() => undefined);
      await admin`DELETE FROM gateway_tokens WHERE app = 'ha-app'`.catch(() => undefined);
      await admin`DELETE FROM gateway_apps WHERE name = 'ha-app'`.catch(() => undefined);
      await admin.close();

      // The host: one claude account in the gateway member store.
      const host = await mkdtemp(join(tmpdir(), "ais-ha-host-"));
      dirs.push(host);
      const idDir = join(host, ".claude", "identities", "acct1");
      const member = join(host, ".ais", "gateway-members", "claude", "acct1");
      await mkdir(idDir, { recursive: true });
      await mkdir(member, { recursive: true });
      await writeFile(join(host, ".claude", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "acct1", label: "acct1", configDir: idDir }] }));
      const grant = { claudeAiOauth: { accessToken: provider.access, refreshToken: provider.refresh, expiresAt: Date.now() + 30 * 86_400_000, scopes: ["user:inference"], subscriptionType: "max" } };
      await writeFile(join(member, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "user@example.com" } }));
      await writeFile(join(member, ".credentials.json"), JSON.stringify(grant));

      // Import (the real CLI), twice: the second run changes nothing.
      const runImport = async (): Promise<string> => {
        const p = Bun.spawn(["bun", join(ROOT, "src/ais.ts"), "gateway", "store", "import"], { cwd: ROOT, env: childEnv({ HOME: host, AIS_GATEWAY_DATABASE_URL: url!, AIS_GATEWAY_STORE_KEY: KEY }), stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        if (code !== 0) throw new Error(`import failed (${code}): ${err}`);
        return out;
      };
      const first = await runImport();
      expect(first).toContain(".ais/gateway-members/claude/acct1/.credentials.json");
      expect(first).toMatch(/[1-9]\d* added/);
      expect(await runImport()).toMatch(/ 0 added, 0 updated/);

      // An app pinned to the account, and a browser binding plus agent token.
      const store = new PgGatewayStore(url);
      await store.putApp({ name: "ha-app", owner: "test", namespace: "test", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "acct1" }, state: "active", createdAt: new Date().toISOString() });
      const appToken = generateToken();
      await store.addToken({ app: "ha-app", prefix: appToken.prefix, hash: appToken.hash, createdAt: new Date().toISOString() });
      await store.putBrowserBinding({ name: "ha-mac", target: { kind: "identity", identity: "acct1" }, profileLabel: "Test", state: "active", createdAt: new Date().toISOString() });
      await store.deleteBrowserTokens("ha-mac");
      const browserToken = generateToken();
      await store.addBrowserToken("ha-mac", browserToken.prefix, browserToken.hash);
      const agentToken = generateToken();
      await store.revokeAgentTokens("acct1");
      await store.addAgentToken({ identity: "acct1", prefix: agentToken.prefix, hash: agentToken.hash, createdAt: new Date().toISOString() });
      await store.close?.();

      // Two replicas, each on an empty scratch HOME: no host files at all.
      const homeA = await mkdtemp(join(tmpdir(), "ais-ha-a-"));
      const homeB = await mkdtemp(join(tmpdir(), "ais-ha-b-"));
      dirs.push(homeA, homeB);
      const [a, b] = await Promise.all([startReplica(homeA), startReplica(homeB)]);

      // Both serve from the store's copy.
      expect((await ask(a.port, appToken.token)).status).toBe(200);
      expect((await ask(b.port, appToken.token)).status).toBe(200);

      // The access token dies: six concurrent requests on both replicas all hit 401 and refresh. One rotation, no reuse.
      provider.rejectedAccess.add(provider.access);
      const results = await Promise.all([a, b, a, b, a, b].map((r) => ask(r.port, appToken.token)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(provider.rotations).toBe(1);
      expect(provider.reused).toBe(0);

      // The store holds the rotated grant, and so does each replica's HOME.
      const hs = new PgHomeStore(url, parseStoreKey(KEY));
      const [row] = await hs.get([".ais/gateway-members/claude/acct1/.credentials.json"]);
      expect(row!.content.toString("utf8")).toContain(provider.refresh);
      await sleep(1_500);
      for (const h of [homeA, homeB]) expect(await readFile(join(h, ".ais/gateway-members/claude/acct1/.credentials.json"), "utf8")).toContain(provider.refresh);
      // The registry paths were translated through the imported host home: no file outside the scratch homes was needed.

      // Browser: the extension's socket is on A, the agent calls B.
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}/browser/connect`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: browserToken.token, version: "1.0.0" }));
        ws.onerror = () => reject(new Error("socket error"));
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data)) as { t: string; req?: { id: string } };
          if (m.t === "welcome") resolve();
          if (m.t === "call" && m.req) ws.send(JSON.stringify({ t: "result", result: { id: m.req.id, ok: true, content: [{ type: "text", text: "from-a" }] } }));
        };
      });
      let call: { ok?: boolean; content?: Array<{ text: string }>; error?: string } = {};
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`http://127.0.0.1:${b.port}/browser/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${agentToken.token}`, "content-type": "application/json" },
          body: JSON.stringify({ session: { id: "s1", label: "t" }, tool: "read_page", args: {} }),
        });
        call = (await res.json()) as typeof call;
        if (call.ok) break;
        await sleep(200);
      }
      expect(call.ok).toBe(true);
      expect(call.content?.[0]?.text).toBe("from-a");
      ws.close();

      // The replica that rotated dies hard (the journal names it). The other keeps serving, and refreshes on its own when the
      // token dies again (the survivor has not refreshed itself yet, so the per-replica 401 cooldown does not apply).
      const j = new SQL(url);
      const [rot] = await j`SELECT holder FROM gateway_refresh_journal WHERE outcome = 'refreshed' ORDER BY id DESC LIMIT 1`;
      await j.close();
      const rotatorPid = Number(String(rot.holder).split(":").pop());
      const [dead, alive] = rotatorPid === a.proc.pid ? [a, b] : [b, a];
      expect(dead.proc.pid).toBe(rotatorPid);
      dead.proc.kill("SIGKILL");
      await dead.proc.exited;
      expect((await ask(alive.port, appToken.token)).status).toBe(200);
      provider.rejectedAccess.add(provider.access);
      expect((await ask(alive.port, appToken.token)).status).toBe(200);
      expect(provider.rotations).toBe(2);
      expect(provider.reused).toBe(0);
      expect((await fetch(`http://127.0.0.1:${alive.port}/readyz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${alive.port}/healthz`)).status).toBe(200);
      await hs.close();
    }, 90_000);
  });
}
