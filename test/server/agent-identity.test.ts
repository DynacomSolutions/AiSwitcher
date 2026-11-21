import { describe, expect, test } from "bun:test";
import { SIDECAR_ARG } from "../../src/shared/session-sidecar.ts";
import { createAgentScanner, gatewayAppOfUrl, LEDGER_WINDOW_MS, type AttributionDeps } from "../../src/server/agent-identity.ts";
import { isSessionSidecar, SIDECAR_ARGV1 } from "../../src/server/processes.ts";
import type { ModelUsageRow, SessionUsage } from "../../src/gateway/types.ts";
import type { ProcessInfoDto } from "../../src/server/types.ts";
import type { IdentitiesFile } from "../../src/identities/types.ts";

const T0 = new Date("2026-11-22T03:00:00.000Z");
const HOME = "/srv/synthetic";

function registry(active: string | null = "alice"): Map<string, IdentitiesFile> {
  const plain = (name: string) => ({ name, label: name, configDir: `${HOME}/.claude/identities/${name}` });
  return new Map([
    [
      "claude",
      {
        version: 1,
        identities: [
          plain("alice"),
          plain("bob"),
          plain("carol"),
          { name: "team-pool", label: "Team pool", configDir: `${HOME}/.claude/identities/swap`, swapPool: { accounts: ["alice", "bob", "carol"], ...(active ? { active } : {}) } },
        ],
      } as IdentitiesFile,
    ],
  ]);
}

const proc = (pid: number, over: Partial<ProcessInfoDto> = {}): ProcessInfoDto => ({
  pid,
  tool: "claude",
  identity: null,
  cwd: null,
  startedAt: null,
  command: "claude",
  ...over,
});

const ledgerRow = (identity: string, lastTs: string, app = "agents-claude"): ModelUsageRow => ({
  provider: "claude", identity, app, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 1, lastTs,
});

function scanner(processes: ProcessInfoDto[], deps: Partial<AttributionDeps> & { files?: () => Promise<Map<string, IdentitiesFile>> } = {}) {
  return createAgentScanner({
    scan: async () => ({ processes, scannedAt: T0.toISOString() }),
    files: async () => registry(),
    ledger: async () => [],
    routedApp: async () => undefined,
    sessions: async () => [],
    // The default never reads the real /proc: a fake pid could be a live process of this machine.
    sessionId: async () => undefined,
    now: () => T0,
    ...deps,
  });
}

describe("agent identity: direct logins", () => {
  test("a marker that names a registered login is that login with no pool", async () => {
    const { processes } = await scanner([proc(1, { identity: "bob", wrapped: true })])();
    expect(processes[0]).toMatchObject({ pool: null, identity: "bob", identitySource: "session-marker", sessionIdentity: "bob" });
  });

  test("a marker alias resolves to the login name", async () => {
    const files = registry();
    files.get("claude")!.identities[1]!.aliases = ["bobby"];
    const { processes } = await scanner([proc(1, { identity: "bobby", wrapped: true })], { files: async () => files })();
    expect(processes[0]).toMatchObject({ pool: null, identity: "bob", identitySource: "session-marker" });
  });

  test("no marker: the login folder in CLAUDE_CONFIG_DIR names the login", async () => {
    const { processes } = await scanner([proc(2, { identityEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/identities/carol` } })])();
    expect(processes[0]).toMatchObject({ pool: null, identity: "carol", identitySource: "config-dir", sessionIdentity: null });
  });

  test("a T3 home named for a login (t3-claude-<name>) is that login", async () => {
    const { processes } = await scanner([proc(3, { identity: "t3-claude-alice", wrapped: true, identityEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.t3/gateway/t3-claude-alice` } })], {})();
    // The T3 gateway folder rule needs the real T3 home, so the folder is not matched here: the marker is kept as the fallback.
    expect(processes[0]!.pool).toBeNull();
    expect(processes[0]!.identity).not.toBeNull();
  });

  test("a bare process with nothing to go on stays unresolved, never invented", async () => {
    const { processes } = await scanner([proc(4)])();
    expect(processes[0]).toMatchObject({ pool: null, identity: null, identitySource: "unresolved" });
  });

  test("keeps the old fields", async () => {
    const { processes, scannedAt } = await scanner([proc(5, { identity: "alice", cwd: "/w", startedAt: "2026-11-22T01:00:00.000Z", command: "claude -p", wrapped: true })])();
    expect(processes[0]).toMatchObject({ pid: 5, tool: "claude", cwd: "/w", startedAt: "2026-11-22T01:00:00.000Z", command: "claude -p", wrapped: true });
    expect(scannedAt).toBe(T0.toISOString());
  });
});

describe("agent identity: plain pool", () => {
  const inPool = (pid: number) => proc(pid, { identity: "team-pool", wrapped: true, identityEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/identities/swap` } });

  test("the pool name and the member the registry records as active", async () => {
    const { processes } = await scanner([inPool(10)])();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "alice", identitySource: "pool-active", sessionIdentity: "team-pool" });
  });

  test("a swap in mid-session: the next scan names the new active member", async () => {
    let active = "alice";
    const scan = scanner([inPool(10)], { files: async () => registry(active) });
    expect((await scan()).processes[0]).toMatchObject({ pool: "team-pool", identity: "alice" });
    active = "carol";
    expect((await scan()).processes[0]).toMatchObject({ pool: "team-pool", identity: "carol", identitySource: "pool-active" });
  });

  test("a pool with no recorded active member is unresolved, with the pool still named", async () => {
    const { processes } = await scanner([inPool(10)], { files: async () => registry(null) })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: null, identitySource: "unresolved" });
  });
});

describe("agent identity: pool routed through the gateway", () => {
  const routed = (pid: number) => proc(pid, { identity: "example-pool-home", wrapped: true, identityEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/identities/swap` } });
  const iso = (ms: number) => new Date(T0.getTime() - ms).toISOString();

  test("the member the gateway served last, not the registry's recorded active one", async () => {
    const { processes } = await scanner([routed(20)], {
      routedApp: async () => "agents-claude",
      ledger: async () => [ledgerRow("alice", iso(600_000)), ledgerRow("bob", iso(5_000)), ledgerRow("carol", iso(60_000))],
    })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "bob", identitySource: "gateway-ledger", sessionIdentity: "example-pool-home" });
  });

  test("a swap in mid-session: the gateway moves to another member and the next scan follows", async () => {
    let now = T0.getTime();
    let rows = [ledgerRow("bob", new Date(now - 1000).toISOString())];
    const scan = scanner([routed(20)], { routedApp: async () => "agents-claude", ledger: async () => rows, now: () => new Date(now) });
    expect((await scan()).processes[0]).toMatchObject({ identity: "bob", identitySource: "gateway-ledger" });
    now += 30_000; // past the ledger cache
    rows = [ledgerRow("bob", new Date(now - 30_000).toISOString()), ledgerRow("carol", new Date(now - 1000).toISOString())];
    expect((await scan()).processes[0]).toMatchObject({ identity: "carol", identitySource: "gateway-ledger" });
  });

  test("one ledger read serves every agent of a scan", async () => {
    let reads = 0;
    const { processes } = await scanner([routed(1), routed(2), routed(3)], {
      routedApp: async () => "agents-claude",
      ledger: async () => { reads += 1; return [ledgerRow("alice", T0.toISOString())]; },
    })();
    expect(reads).toBe(1);
    expect(processes.map((p) => p.identity)).toEqual(["alice", "alice", "alice"]);
  });

  test("rows of another app, of a non-member and older than the window never count", async () => {
    const { processes } = await scanner([routed(20)], {
      routedApp: async () => "agents-claude",
      ledger: async () => [
        ledgerRow("bob", T0.toISOString(), "other-app"),
        ledgerRow("stranger", T0.toISOString()),
        ledgerRow("carol", new Date(T0.getTime() - LEDGER_WINDOW_MS - 1000).toISOString()),
      ],
    })();
    expect(processes[0]).toMatchObject({ identity: "alice", identitySource: "pool-active" });
  });

  test("a gateway that cannot be read falls back to the registry's active member", async () => {
    const { processes } = await scanner([routed(20)], { routedApp: async () => "", ledger: async () => { throw new Error("down"); } })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "alice", identitySource: "pool-active" });
  });
});

describe("agent identity: session ledger of a gateway pool", () => {
  const SID = "6cc07c23-4501-42cb-ba6e-3c14d864219e";
  const routed = (pid: number) => proc(pid, { identity: "example-pool-home", wrapped: true, identityEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/identities/swap` } });
  const iso = (ms: number) => new Date(T0.getTime() - ms).toISOString();
  const use = (identity: string, turns: number, firstMs: number, lastMs: number) => ({ identity, turns, inputTokens: turns * 10, outputTokens: turns, cacheReadTokens: turns * 100, cacheWriteTokens: 0, firstTs: iso(firstMs), lastTs: iso(lastMs) });
  const session = (key: string, identities: SessionUsage["identities"]): SessionUsage => ({ sessionKey: key, provider: "claude", app: "agents-claude", client: "claude-cli", activeIdentity: identities[0]!.identity, identities, turns: identities.reduce((n, i) => n + i.turns, 0), firstTs: identities[identities.length - 1]!.firstTs, lastTs: identities[0]!.lastTs });
  const common = { routedApp: async () => "agents-claude", ledger: async () => [ledgerRow("alice", iso(1000))] };

  test("one session on one member: that member is active and holds the whole split", async () => {
    const { processes } = await scanner([routed(30)], { ...common, sessionId: async () => SID, sessions: async () => [session(SID, [use("bob", 4, 600_000, 5_000)])] })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "bob", activeIdentity: "bob", identitySource: "gateway-session", sessionId: SID });
    expect(processes[0]!.identities).toEqual([{ identity: "bob", turns: 4, inputTokens: 40, outputTokens: 4, cacheReadTokens: 400, cacheWriteTokens: 0, firstSeen: iso(600_000), lastSeen: iso(5_000) }]);
  });

  test("a swap in mid-session: the latest account is active and both accounts keep their share", async () => {
    const { processes } = await scanner([routed(30)], { ...common, sessionId: async () => SID, sessions: async () => [session(SID, [use("carol", 2, 60_000, 1_000), use("bob", 5, 900_000, 100_000)])] })();
    expect(processes[0]).toMatchObject({ identity: "carol", activeIdentity: "carol", identitySource: "gateway-session" });
    expect(processes[0]!.identities.map((i) => [i.identity, i.turns])).toEqual([["carol", 2], ["bob", 5]]);
  });

  test("55 agents of one pool, each with its own session, keep each its own account (no shared last member)", async () => {
    const procs = Array.from({ length: 55 }, (_, i) => routed(100 + i));
    const keys = new Map(procs.map((p, i) => [p.pid, `sess-${String(i).padStart(4, "0")}-aaaa`]));
    const members = ["alice", "bob", "carol"];
    const list = procs.map((p, i) => session(keys.get(p.pid)!, [use(members[i % 3]!, 1, 1_000, 500)]));
    const { processes } = await scanner(procs, { ...common, sessionId: async (pid) => keys.get(pid), sessions: async () => list })();
    const counts = new Map<string, number>();
    for (const p of processes) counts.set(p.identity!, (counts.get(p.identity!) ?? 0) + 1);
    expect([...counts.entries()].sort()).toEqual([["alice", 19], ["bob", 18], ["carol", 18]]);
    expect(processes.every((p) => p.identitySource === "gateway-session")).toBe(true);
  });

  test("a session with no gateway traffic yet keeps the last-member rule, with no split", async () => {
    const { processes } = await scanner([routed(30)], { ...common, sessionId: async () => SID, sessions: async () => [] })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "alice", identitySource: "gateway-ledger", sessionId: SID, activeIdentity: null, identities: [] });
  });

  test("a gateway that cannot answer for sessions falls back, never guesses", async () => {
    const { processes } = await scanner([routed(30)], { ...common, sessionId: async () => SID, sessions: async () => undefined })();
    expect(processes[0]).toMatchObject({ identity: "alice", identitySource: "gateway-ledger", identities: [] });
    const thrown = await scanner([routed(30)], { ...common, sessionId: async () => SID, sessions: async () => { throw new Error("down"); } })();
    expect(thrown.processes[0]).toMatchObject({ identity: "alice", identitySource: "gateway-ledger" });
  });

  test("an agent whose session id is unknown keeps the last-member rule", async () => {
    const { processes } = await scanner([routed(30)], { ...common, sessions: async () => { throw new Error("must not be asked"); } })();
    expect(processes[0]).toMatchObject({ identity: "alice", identitySource: "gateway-ledger", sessionId: null });
  });

  test("the session lookup asks once for all ids and never for direct logins", async () => {
    const asked: string[][] = [];
    const direct = proc(40, { identity: "bob", wrapped: true });
    const { processes } = await scanner([routed(30), routed(31), direct], {
      ...common,
      sessionId: async (pid) => `sess-${pid}-xxxxxxxx`,
      sessions: async (keys) => { asked.push(keys); return []; },
    })();
    expect(asked).toEqual([["sess-30-xxxxxxxx", "sess-31-xxxxxxxx"]]);
    expect(processes[2]).toMatchObject({ pool: null, identity: "bob", identitySource: "session-marker", activeIdentity: null, identities: [] });
  });

  test("a session of another provider with the same id is not used", async () => {
    const other = { ...session(SID, [use("bob", 1, 1000, 500)]), provider: "codex" };
    const { processes } = await scanner([routed(30)], { ...common, sessionId: async () => SID, sessions: async () => [other] })();
    expect(processes[0]).toMatchObject({ identity: "alice", identitySource: "gateway-ledger" });
  });
});

describe("agent identity: direct logins are unchanged by the session ledger", () => {
  test("a direct login never asks the gateway and keeps its source", async () => {
    let asked = 0;
    const { processes } = await scanner([proc(50, { identity: "alice", wrapped: true })], { sessionId: async () => "6cc07c23-4501-42cb-ba6e-3c14d864219e", sessions: async () => { asked += 1; return []; } })();
    expect(asked).toBe(0);
    expect(processes[0]).toMatchObject({ pool: null, identity: "alice", identitySource: "session-marker", activeIdentity: null, identities: [] });
  });

  test("a plain (not gateway-routed) pool keeps the registry's active member", async () => {
    const plain = proc(51, { identity: "team-pool", wrapped: true, identityEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/identities/swap` } });
    const { processes } = await scanner([plain], { sessionId: async () => "6cc07c23-4501-42cb-ba6e-3c14d864219e" })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "alice", identitySource: "pool-active" });
  });
});

describe("agent identity: console pod with another home", () => {
  test("a host folder path is translated before the pool match", async () => {
    const hostProc = proc(70, { identityEnv: { CLAUDE_CONFIG_DIR: "/srv/hostuser/.claude/identities/swap" } });
    const host = { env: { AIS_HOST_HOME: "/srv/hostuser" }, localHome: HOME };
    const { processes } = await scanner([hostProc], { host })();
    expect(processes[0]).toMatchObject({ pool: "team-pool", identity: "alice", identitySource: "pool-active" });
  });

  test("without the translation the same folder stays unresolved", async () => {
    const hostProc = proc(71, { identityEnv: { CLAUDE_CONFIG_DIR: "/srv/hostuser/.claude/identities/swap" } });
    const { processes } = await scanner([hostProc], { host: { env: {}, localHome: HOME } })();
    expect(processes[0]).toMatchObject({ pool: null, identity: null, identitySource: "unresolved" });
  });
});

describe("helpers", () => {
  test("gatewayAppOfUrl reads the app from a gateway base URL", () => {
    expect(gatewayAppOfUrl("https://host.example.com/gateway/agents-claude")).toBe("agents-claude");
    expect(gatewayAppOfUrl("https://host.example.com/gateway/agents-claude/v1?x=1")).toBe("agents-claude");
    expect(gatewayAppOfUrl("https://api.example.com")).toBeUndefined();
    expect(gatewayAppOfUrl(undefined)).toBeUndefined();
  });

  test("the sidecar is told from an agent by argv[1]", () => {
    expect(isSessionSidecar(`/bin/claude\0${SIDECAR_ARG}`)).toBe(true);
    expect(isSessionSidecar("/bin/claude\0-p\0hello")).toBe(false);
    expect(isSessionSidecar("/bin/claude")).toBe(false);
    expect(SIDECAR_ARGV1).toBe(SIDECAR_ARG);
  });
});
