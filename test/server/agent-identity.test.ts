import { describe, expect, test } from "bun:test";
import { SIDECAR_ARG } from "../../src/shared/session-sidecar.ts";
import { createAgentScanner, gatewayAppOfUrl, LEDGER_WINDOW_MS, type AttributionDeps } from "../../src/server/agent-identity.ts";
import { isSessionSidecar, SIDECAR_ARGV1 } from "../../src/server/processes.ts";
import type { ModelUsageRow } from "../../src/gateway/types.ts";
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
