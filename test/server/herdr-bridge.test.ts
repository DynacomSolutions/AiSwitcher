import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fsp } from "node:fs";
import {
  DEFAULT_HERDR_BRIDGE_CATEGORIES,
  DEFAULT_HERDR_BRIDGE_INTERVAL_S,
  MAX_TTL_MS,
  MIN_HERDR_BRIDGE_INTERVAL_S,
  PENDING_REASON,
  classifyPaneListFailure,
  classifyProbe,
  computePaneTokens,
  HerdrBridgeScheduler,
  loadHerdrBridgeConfig,
  parseHerdrBridgeConfig,
  parsePaneList,
  parseProcessInfo,
  tokenArgs,
  toolFromIdentityEnv,
  windowsForIdentity,
  type HerdrBridgeSchedulerDeps,
  type HerdrCommandResult,
} from "../../src/server/herdr-bridge.ts";
import { parseIdentityEnviron } from "../../src/server/processes.ts";

const TMP = mkdtempSync(join(tmpdir(), "ais-herdr-bridge-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const NOW = new Date(2026, 8, 10, 12, 0, 0);

/** Real captured `herdr pane list` output (2026-09-10, herdr 0.8.2), the
 * live line truncated to four representative panes verbatim. */
const PANE_LIST_JSON = await Bun.file(join(import.meta.dir, "..", "fixtures", "herdr", "pane-list.json")).text();
/** Real captured `herdr pane process-info --pane w2B:p1` output. */
const PROCESS_INFO_JSON = await Bun.file(join(import.meta.dir, "..", "fixtures", "herdr", "process-info.json")).text();

function ok(stdout = ""): HerdrCommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", timedOut: false };
}

function failed(stderr = "", exitCode: number | null = 1): HerdrCommandResult {
  return { ok: false, exitCode, stdout: "", stderr, timedOut: false };
}

describe("parseHerdrBridgeConfig", () => {
  test("defaults when absent; clamps the interval up to the floor", () => {
    expect(parseHerdrBridgeConfig(undefined)).toEqual({
      enabled: true,
      intervalS: DEFAULT_HERDR_BRIDGE_INTERVAL_S,
      categories: [...DEFAULT_HERDR_BRIDGE_CATEGORIES],
      push: true,
    });
    expect(parseHerdrBridgeConfig({ intervalS: 5 }).intervalS).toBe(MIN_HERDR_BRIDGE_INTERVAL_S);
    expect(parseHerdrBridgeConfig({ intervalS: "abc" }).intervalS).toBe(DEFAULT_HERDR_BRIDGE_INTERVAL_S);
    expect(parseHerdrBridgeConfig({ intervalS: 120 }).intervalS).toBe(120);
  });

  test("filters unknown categories, dedupes, and falls back when nothing valid remains", () => {
    expect(parseHerdrBridgeConfig({ categories: ["session", "month", "hour", "session"] }).categories).toEqual(["session", "month"]);
    expect(parseHerdrBridgeConfig({ categories: ["decade"] }).categories).toEqual([...DEFAULT_HERDR_BRIDGE_CATEGORIES]);
    expect(parseHerdrBridgeConfig({ categories: "week" }).categories).toEqual([...DEFAULT_HERDR_BRIDGE_CATEGORIES]);
  });

  test("enabled and push default on and can be switched off explicitly", () => {
    expect(parseHerdrBridgeConfig({ enabled: false }).enabled).toBe(false);
    expect(parseHerdrBridgeConfig({ push: false }).push).toBe(false);
    expect(parseHerdrBridgeConfig({ enabled: 0 }).enabled).toBe(false);
  });
});

describe("loadHerdrBridgeConfig", () => {
  test("reads a machine-local config file; a missing file is simply defaults", async () => {
    const path = join(TMP, "herdr-bridge.json");
    await fsp.writeFile(path, JSON.stringify({ enabled: true, intervalS: 30, categories: ["session", "week", "month"], push: false }));
    const loaded = await loadHerdrBridgeConfig(path);
    expect(loaded).toEqual({ enabled: true, intervalS: 30, categories: ["session", "week", "month"], push: false });
    expect(await loadHerdrBridgeConfig(join(TMP, "missing.json"))).toEqual(parseHerdrBridgeConfig(undefined));
  });
});

describe("parsePaneList (real captured line)", () => {
  test("parses the captured pane_list envelope into panes", () => {
    const panes = parsePaneList(PANE_LIST_JSON);
    expect(panes.map((p) => p.pane_id)).toEqual(["w1:p1G", "w2B:p1", "w1:p1Q", "w2C:p1"]);
    expect(panes[0]).toMatchObject({ agent: "codex", agent_status: "idle" });
    expect(panes[2]!.agent).toBeUndefined(); // bare shell pane
  });

  test("herdr's own focused flag rides through verbatim", () => {
    const panes = parsePaneList(PANE_LIST_JSON);
    expect(panes.every((p) => p.focused === false)).toBe(true);
  });

  test("tolerant: junk, missing result, or non-array panes are zero panes", () => {
    expect(parsePaneList("not json")).toEqual([]);
    expect(parsePaneList("{}")).toEqual([]);
    expect(parsePaneList(JSON.stringify({ result: { panes: "nope" } }))).toEqual([]);
    expect(parsePaneList(JSON.stringify({ result: { panes: [{}, { pane_id: "" }, { pane_id: "w1:p1" }] } }))).toEqual([
      { pane_id: "w1:p1" },
    ]);
  });
});

describe("parseProcessInfo (real captured output)", () => {
  test("foreground processes first (with names), then the shell pid, deduped", () => {
    const candidates = parseProcessInfo(PROCESS_INFO_JSON);
    expect(candidates).toEqual([
      { pid: 848316, name: "opencode" },
      { pid: 849083, name: "opencode" },
      { pid: 853426, name: "codebase-memory" },
      { pid: 802685 },
    ]);
  });

  test("tolerant: junk and missing fields yield no candidates; duplicates collapse", () => {
    expect(parseProcessInfo("garbage")).toEqual([]);
    expect(parseProcessInfo(JSON.stringify({ result: {} }))).toEqual([]);
    const deduped = parseProcessInfo(
      JSON.stringify({
        result: {
          process_info: {
            foreground_processes: [{ pid: 5, name: "codex" }, { pid: 5, name: "codex" }, { pid: "x" }, {}],
            shell_pid: 5,
          },
        },
      }),
    );
    expect(deduped).toEqual([{ pid: 5, name: "codex" }]);
  });
});

describe("classifyProbe (feature detection)", () => {
  test("exit 0 means the CLI knows report-metadata", () => {
    expect(classifyProbe(0, "Report display-only pane metadata\n...", "")).toBe("supported");
  });

  test("an unknown-subcommand error means pending", () => {
    expect(classifyProbe(2, "", "error: unrecognized subcommand 'report-metadata'")).toBe("pending");
    expect(classifyProbe(1, "", "unknown command 'report-metadata' for 'herdr pane'")).toBe("pending");
  });

  test("a bare-invocation usage dump naming the subcommand is still supported", () => {
    const usage = 'usage: herdr pane report-metadata <pane_id> --source ID [--token NAME=VALUE] [--ttl-ms N]';
    expect(classifyProbe(2, "", usage)).toBe("supported");
  });

  test("anything else (spawn failure, timeout) is pending", () => {
    expect(classifyProbe(null, "", "")).toBe("pending");
    expect(classifyProbe(124, "", "herdr pane timed out after 5000ms")).toBe("pending");
  });
});

describe("classifyPaneListFailure", () => {
  test("not-running shapes vs anything else", () => {
    expect(classifyPaneListFailure("error: no running herdr server at /home/me/.local/share/herdr/herdr.sock")).toBe("not-running");
    expect(classifyPaneListFailure("failed to connect to server socket")).toBe("not-running");
    expect(classifyPaneListFailure("panic: unexpected fork bomb")).toBe("error");
    expect(classifyPaneListFailure("")).toBe("error");
  });
});

describe("token contract", () => {
  const results = [
    { identity: { name: "workco" }, windows: [{ category: "session", usedPercent: 18.4 }, { category: "week", usedPercent: 42 }] },
    { identity: { name: "other" }, windows: [{ category: "session", usedPercent: 99 }] },
    { identity: { name: "workco" }, status: "unavailable", windows: [] },
  ];

  test("windowsForIdentity extracts only the named identity's windows", () => {
    expect(windowsForIdentity(results, "workco")).toEqual([{ category: "session", usedPercent: 18.4 }, { category: "week", usedPercent: 42 }]);
    expect(windowsForIdentity(results, "missing")).toEqual([]);
    expect(windowsForIdentity("junk", "workco")).toEqual([]);
  });

  test("computePaneTokens: present categories round to integers; absent ones are omitted", () => {
    const tokens = computePaneTokens("workco", windowsForIdentity(results, "workco"), ["session", "week", "month"]);
    expect(tokens).toEqual({ identity: "workco", session: 18, week: 42, summary: "s:18% w:42%" });
  });

  test("the max percent wins across providers of one identity; rounding rounds half up", () => {
    const multi = [
      { identity: { name: "pi" }, windows: [{ category: "session", usedPercent: 10 }] },
      { identity: { name: "pi" }, windows: [{ category: "session", usedPercent: 50.5 }, { category: "month", usedPercent: 7.2 }] },
    ];
    const tokens = computePaneTokens("pi", windowsForIdentity(multi, "pi"), ["session", "week", "month"]);
    expect(tokens).toEqual({ identity: "pi", session: 51, month: 7, summary: "s:51% m:7%" });
  });

  test("categories config scopes the computation even when data exists", () => {
    const windows = [{ category: "session", usedPercent: 20 }, { category: "week", usedPercent: 40 }, { category: "month", usedPercent: 60 }];
    expect(computePaneTokens("x", windows, ["session", "week"])).toEqual({ identity: "x", session: 20, week: 40, summary: "s:20% w:40%" });
    expect(computePaneTokens("x", windows, ["month"])).toEqual({ identity: "x", month: 60, summary: "m:60%" });
  });

  test("no window data (or junk) means NO tokens at all", () => {
    expect(computePaneTokens("x", [], ["session", "week"])).toBeUndefined();
    expect(computePaneTokens("x", [{ category: "other", usedPercent: 50 }], ["session", "week"])).toBeUndefined();
    expect(computePaneTokens("x", [{ category: "session", usedPercent: "80" }], ["session"])).toBeUndefined();
    expect(computePaneTokens("x", [{ category: "session", usedPercent: Number.NaN }], ["session"])).toBeUndefined();
  });

  test("tokenArgs emits the $ais_* names literally, summary spaces in one argv element", () => {
    const args = tokenArgs({ identity: "workco", session: 18, week: 42, summary: "s:18% w:42%" });
    expect(args).toEqual([
      "--token",
      "$ais_identity=workco",
      "--token",
      "$ais_session=18",
      "--token",
      "$ais_week=42",
      "--token",
      "$ais_limits=s:18% w:42%",
    ]);
  });
});

describe("toolFromIdentityEnv", () => {
  test("primary config var wins; ali beats zai because its own var scores higher", () => {
    expect(toolFromIdentityEnv({ CLAUDE_CONFIG_DIR: "~/.claude/identities/work" })).toBe("claude");
    expect(toolFromIdentityEnv({ CODEX_HOME: "~/.codex/identities/work" })).toBe("codex");
    expect(toolFromIdentityEnv({ CRUSH_GLOBAL_CONFIG: "~/.zai", CRUSH_GLOBAL_DATA: "~/.zai/data" })).toBe("zai");
    // ali mirrors crush's vars as EXTRAS plus its own ALI_CONFIG_DIR: the
    // primary var (2 points) must outrank zai's extras.
    expect(toolFromIdentityEnv({ ALI_CONFIG_DIR: "~/.ali", CRUSH_GLOBAL_CONFIG: "~/.ali", CRUSH_GLOBAL_DATA: "~/.ali/data" })).toBe("ali");
    expect(toolFromIdentityEnv({})).toBeUndefined();
  });
});

describe("parseIdentityEnviron (shared /proc scanner rules)", () => {
  test("marker sets identity + wrapped; config-dir vars are captured; empty marker stays wrapped", () => {
    const env = `PATH=/usr/bin\0AI_PROFILE_SWITCHER_SESSION=workco\0OPENCODE_CONFIG_DIR=/home/user/.ais/npm/identities/workco\0SECRET_KEY=never-read-here\0`;
    expect(parseIdentityEnviron(env)).toEqual({
      identity: "workco",
      wrapped: true,
      identityEnv: { OPENCODE_CONFIG_DIR: "/home/user/.ais/npm/identities/workco" },
    });
    expect(parseIdentityEnviron("AI_PROFILE_SWITCHER_SESSION=")).toEqual({ identity: null, wrapped: true, identityEnv: {} });
    expect(parseIdentityEnviron("PATH=/usr/bin")).toEqual({ identity: null, wrapped: false, identityEnv: {} });
  });
});

/* ----------------------------- scheduler tests ----------------------------- */

interface Harness {
  pushes: Array<{ paneId: string; args: string[] }>;
  deps(overrides?: Partial<HerdrBridgeSchedulerDeps>): HerdrBridgeSchedulerDeps;
}

function harness(): Harness {
  const pushes: Array<{ paneId: string; args: string[] }> = [];
  return {
    pushes,
    deps(overrides: Partial<HerdrBridgeSchedulerDeps> = {}): HerdrBridgeSchedulerDeps {
      return {
        config: { enabled: true, intervalS: 15, categories: ["session", "week"], push: true },
        paneList: async () => ok(PANE_LIST_JSON),
        processInfo: async () => failed("process info unavailable"),
        probe: async () => ({ verdict: "supported", version: "0.8.2" }),
        readEnviron: async () => undefined,
        fetchLimits: async () => [],
        push: async (paneId, args) => {
          pushes.push({ paneId, args });
          return ok();
        },
        now: () => NOW,
        log: () => {},
        ...overrides,
      };
    },
  };
}

const MARKED_ENV = { identity: "workco", wrapped: true as const, identityEnv: { OPENCODE_CONFIG_DIR: "/home/user/.ais/npm/identities/workco" } };

describe("HerdrBridgeScheduler state machine", () => {
  test("idle: herdr not running", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({ paneList: async () => failed("error: no running herdr server at ~/.local/share/herdr/herdr.sock") }),
    );
    await scheduler.tick();
    const status = scheduler.status();
    expect(status.state).toBe("idle");
    expect(status.lastError).toContain("no running herdr server");
    expect(status.lastCycleAt).toBe(NOW.toISOString());
    expect(status.panes).toEqual([]);
  });

  test("a non-idle pane-list failure keeps the previous state and records the error", async () => {
    const h = harness();
    let fail = false;
    const scheduler = new HerdrBridgeScheduler(
      h.deps({ paneList: async () => (fail ? failed("panic: disk on fire") : ok(PANE_LIST_JSON)) }),
    );
    await scheduler.tick(); // becomes active
    expect(scheduler.status().state).toBe("active");
    fail = true;
    await scheduler.tick();
    expect(scheduler.status().state).toBe("active"); // transient failure: state held
    expect(scheduler.status().lastError).toContain("pane list failed");
  });

  test("pending: probe says unsupported; panes still attributed, pushes skipped, reason recorded", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        probe: async () => ({ verdict: "pending" }),
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => [{ identity: { name: "workco" }, windows: [{ category: "session", usedPercent: 18 }] }],
      }),
    );
    await scheduler.tick();
    const status = scheduler.status();
    expect(status.state).toBe("pending");
    expect(status.pendingReason).toBe(PENDING_REASON);
    expect(status.panes).toHaveLength(1);
    expect(status.panes[0]).toMatchObject({ paneId: "w2B:p1", identity: "workco", tool: "opencode", session: 18 });
    expect(h.pushes).toEqual([]);
  });

  test("pending flips to active automatically when the probe starts supporting (herdr upgrade, no restart)", async () => {
    const h = harness();
    let verdict: "supported" | "pending" = "pending";
    const scheduler = new HerdrBridgeScheduler(h.deps({ probe: async () => ({ verdict, version: "0.8.2" }) }));
    await scheduler.tick();
    expect(scheduler.status().state).toBe("pending");
    verdict = "supported";
    await scheduler.tick();
    expect(scheduler.status().state).toBe("active");
    expect(scheduler.status().pendingReason).toBeUndefined();
    // Probe is cached while supported: a third tick must not re-probe.
    let probes = 0;
    const counting = new HerdrBridgeScheduler(h.deps({ probe: async () => { probes += 1; return { verdict: "supported" }; } }));
    await counting.tick();
    await counting.tick();
    expect(probes).toBe(1);
  });

  test("active: tokens pushed per pane with the documented contract (source, seq, ttl)", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        config: { enabled: true, intervalS: 15, categories: ["session", "week"], push: true },
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async (identity) =>
          identity === "workco"
            ? [{ identity: { name: "workco" }, windows: [{ category: "session", usedPercent: 18.4 }, { category: "week", usedPercent: 42 }] }]
            : [],
      }),
    );
    await scheduler.tick();
    const status = scheduler.status();
    expect(status.state).toBe("active");
    expect(status.lastPushAt).toBe(NOW.toISOString());
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ paneId: "w2B:p1" });
    expect(h.pushes[0]!.args).toEqual([
      "pane",
      "report-metadata",
      "w2B:p1",
      "--source",
      "ais",
      "--token",
      "$ais_identity=workco",
      "--token",
      "$ais_session=18",
      "--token",
      "$ais_week=42",
      "--token",
      "$ais_limits=s:18% w:42%",
      "--seq",
      "1",
      "--ttl-ms",
      "45000",
    ]);
  });

  test("seq increments across pushes; ttl clamps to herdr's 24h max", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        config: { enabled: true, intervalS: 100_000, categories: ["session"], push: true },
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => [{ identity: { name: "workco" }, windows: [{ category: "session", usedPercent: 5 }] }],
      }),
    );
    await scheduler.tick();
    // One pane -> one push (the fixture's other panes are unmarked).
    expect(h.pushes).toHaveLength(1);
    const seqIndex = h.pushes[0]!.args.indexOf("--seq");
    expect(h.pushes[0]!.args[seqIndex + 1]).toBe("1");
    const ttlIndex = h.pushes[0]!.args.indexOf("--ttl-ms");
    expect(h.pushes[0]!.args[ttlIndex + 1]).toBe(String(MAX_TTL_MS));
  });

  test("panes without limits data get NO push but stay in the DTO unadorned", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => [], // fetch failed or nothing reported
      }),
    );
    await scheduler.tick();
    expect(h.pushes).toEqual([]);
    expect(scheduler.status().panes).toEqual([
      { paneId: "w2B:p1", agent: "opencode", agentStatus: "working", tool: "opencode", identity: "workco", title: "OC | Parallel tasks: Bedrock limits, upgra…" },
    ]);
  });

  test("focused is threaded into the DTO only for the focused pane (overview highlight source)", async () => {
    const h = harness();
    const syntheticList = JSON.stringify({
      id: "cli:pane:list",
      result: {
        type: "pane_list",
        panes: [
          { pane_id: "wA:p1", agent: "codex", agent_status: "idle", focused: true },
          { pane_id: "wB:p1", agent: "claude", agent_status: "working", focused: false },
        ],
      },
    });
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        paneList: async () => ok(syntheticList),
        processInfo: async (paneId) => ok(PROCESS_INFO_JSON),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => [],
      }),
    );
    await scheduler.tick();
    const panes = scheduler.status().panes;
    expect(panes).toHaveLength(2);
    expect(panes[0]).toMatchObject({ paneId: "wA:p1", identity: "workco", focused: true });
    expect(panes[1]!.focused).toBeUndefined();
  });

  test("push:=false suppresses writes while everything else still runs", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        config: { enabled: true, intervalS: 15, categories: ["session"], push: false },
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => [{ identity: { name: "workco" }, windows: [{ category: "session", usedPercent: 18 }] }],
      }),
    );
    await scheduler.tick();
    expect(h.pushes).toEqual([]);
    expect(scheduler.status().state).toBe("active");
    expect(scheduler.status().panes[0]?.session).toBe(18);
  });

  test("an unsupported-shaped push failure downgrades to pending once, then stops flapping", async () => {
    const h = harness();
    let verdict: "supported" | "pending" = "supported";
    let pushCount = 0;
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        probe: async () => ({ verdict }),
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => [{ identity: { name: "workco" }, windows: [{ category: "session", usedPercent: 18 }] }],
        push: async () => {
          pushCount += 1;
          return failed("server error: method not implemented yet", 2);
        },
      }),
    );
    await scheduler.tick();
    expect(scheduler.status().state).toBe("pending");
    expect(scheduler.status().pendingReason).toBe(PENDING_REASON);
    expect(scheduler.status().lastError).toContain("metadata push rejected");

    // Next cycle: probe re-runs (supported again), state flips active, the
    // push fails again, but the sticky guard keeps the bridge active with
    // the error surfaced instead of oscillating forever.
    await scheduler.tick();
    expect(scheduler.status().state).toBe("active");
    expect(pushCount).toBe(2);
    expect(scheduler.status().lastError).toContain("metadata push failed");
  });

  test("disabled config: state disabled, tick is a no-op, start() never schedules", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(h.deps({ config: { enabled: false, intervalS: 15, categories: ["session"], push: true } }));
    scheduler.start();
    await scheduler.tick();
    const status = scheduler.status();
    expect(status.state).toBe("disabled");
    expect(status.running).toBe(false);
    expect(status.lastCycleAt).toBeNull();
  });

  test("unattributed panes never reach the DTO (bare shells and vanished processes)", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async () => undefined, // nothing marked
      }),
    );
    await scheduler.tick();
    expect(scheduler.status().panes).toEqual([]);
    expect(h.pushes).toEqual([]);
  });
});

describe("HerdrBridgeScheduler lifecycle", () => {
  test("start/stop toggles running; overlapping ticks collapse", async () => {
    const h = harness();
    let paneListCalls = 0;
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        paneList: async () => {
          paneListCalls += 1;
          await Bun.sleep(30);
          return ok(PANE_LIST_JSON);
        },
      }),
    );
    scheduler.start();
    expect(scheduler.status().running).toBe(true);
    scheduler.stop();
    expect(scheduler.status().running).toBe(false);

    const busy = new HerdrBridgeScheduler(h.deps({ paneList: async () => { paneListCalls += 1; await Bun.sleep(30); return ok(PANE_LIST_JSON); } }));
    await Promise.all([busy.tick(), busy.tick(), busy.tick()]);
    expect(paneListCalls).toBe(1);
  });

  test("a throwing dependency is recorded as lastError, never propagated", async () => {
    const h = harness();
    const scheduler = new HerdrBridgeScheduler(
      h.deps({
        processInfo: async (paneId) => (paneId === "w2B:p1" ? ok(PROCESS_INFO_JSON) : failed("no process info")),
        readEnviron: async (pid) => (pid === 848316 ? MARKED_ENV : undefined),
        fetchLimits: async () => {
          throw new Error("worker exploded");
        },
      }),
    );
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduler.status().lastError).toContain("worker exploded");
  });
});
