import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PANEL_WIDTH,
  HERDR_SESSION,
  buildCreateSteps,
  hasSessionArgs,
  insideHerdrPane,
  parseHerdrArgs,
  parseRemoteConsoleState,
  rightPaneCommand,
  leftPaneCommand,
  nestingConflict,
  shellQuote,
  tunnelArgs,
  remoteStateArgs,
  runHerdrCommand,
  runHerdrPanelCommand,
  type HerdrCommandDeps,
  type HerdrPanelDeps,
} from "../../src/cli/herdr.ts";
import { CliUsageError } from "../../src/cli/errors.ts";

function invocationFlags(overrides: Record<string, string | true> = {}): Record<string, string | true> {
  return { ...overrides };
}

describe("parseHerdrArgs", () => {
  test("defaults: no raw/new/force/remote, width 42, no socket", () => {
    expect(parseHerdrArgs([], invocationFlags())).toEqual({
      raw: false,
      recreate: false,
      force: false,
      remoteAis: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
    });
  });

  test("accepts the documented flags", () => {
    const parsed = parseHerdrArgs(
      [],
      invocationFlags({ raw: true, new: true, force: true, "remote-ais": true, remote: "box", "panel-width": "38", "panel-cmd": "htop", "tmux-socket": "ais-test" }),
    );
    expect(parsed).toEqual({
      raw: true,
      recreate: true,
      force: true,
      remote: "box",
      remoteAis: true,
      panelWidth: 38,
      panelCmd: "htop",
      tmuxSocket: "ais-test",
    });
  });

  test("rejects positionals and a malformed width", () => {
    expect(() => parseHerdrArgs(["extra"], invocationFlags())).toThrow(CliUsageError);
    expect(() => parseHerdrArgs([], invocationFlags({ "panel-width": "42x" }))).toThrow(CliUsageError);
    expect(() => parseHerdrArgs([], invocationFlags({ "panel-width": "200" }))).toThrow(CliUsageError);
    expect(parseHerdrArgs([], invocationFlags({ "panel-width": "42" })).panelWidth).toBe(42);
  });

  test("--remote-ais without --remote is a usage error", () => {
    expect(() => parseHerdrArgs([], invocationFlags({ "remote-ais": true }))).toThrow(CliUsageError);
  });
});

describe("nestingConflict", () => {
  test("TMUX set means tmux; HERDR_* vars mean herdr; clean env passes", () => {
    expect(nestingConflict({ TMUX: "/tmp/tmux-0/default,1,0" })).toBe("tmux");
    expect(nestingConflict({ HERDR_PANE_ID: "w1:p1" })).toBe("herdr");
    expect(nestingConflict({ PATH: "/usr/bin" })).toBeUndefined();
  });
});

describe("insideHerdrPane", () => {
  test("any HERDR_* variable means this shell sits in a herdr pane", () => {
    expect(insideHerdrPane({ HERDR_PANE_ID: "w1:p1" })).toBe(true);
    expect(insideHerdrPane({ HERDR_WORKSPACE_ID: "ws" })).toBe(true);
  });

  test("plain tmux or a clean env does not", () => {
    expect(insideHerdrPane({ TMUX: "/tmp/tmux-0/default,1,0" })).toBe(false);
    expect(insideHerdrPane({})).toBe(false);
  });
});

describe("pane command construction", () => {
  test("left pane runs the resolved binary; --remote uses herdr's own remote form", () => {
    expect(leftPaneCommand("/usr/bin/herdr")).toBe("/usr/bin/herdr");
    expect(leftPaneCommand("/usr/bin/herdr", "box.example")).toBe("/usr/bin/herdr --remote box.example");
  });

  test("right pane defaults to aistui --overview", () => {
    expect(rightPaneCommand({ tuiPath: "/opt/tools/bin/aistui" })).toBe(
      "/opt/tools/bin/aistui --overview",
    );
  });

  test("--remote-ais delegates the right pane to the hidden panel subcommand", () => {
    const command = rightPaneCommand({
      tuiPath: "",
      aisEntrypoint: ["/usr/local/bin/ais"],
      remoteAis: true,
      remote: "box.example",
    });
    expect(command).toBe("/usr/local/bin/ais __herdr_panel --remote=box.example");
    // Dev mode: bun + script path both ride the same quoting.
    const dev = rightPaneCommand({
      tuiPath: "",
      aisEntrypoint: ["/usr/bin/bun", "/repos/AiSwitcher/src/ais.ts"],
      remoteAis: true,
      remote: "box",
    });
    expect(dev).toBe("/usr/bin/bun /repos/AiSwitcher/src/ais.ts __herdr_panel --remote=box");
  });

  test("--panel-cmd wins over everything else", () => {
    expect(
      rightPaneCommand({
        tuiPath: "/tui",
        panelCmd: "btop",
        aisEntrypoint: ["/ais"],
        remoteAis: true,
        remote: "box",
      }),
    ).toBe("btop");
  });

  test("shellQuote survives single quotes in paths", () => {
    expect(shellQuote("/opt/it's/herdr")).toBe("'/opt/it'\\''s/herdr'");
  });
});

describe("buildCreateSteps", () => {
  const steps = buildCreateSteps({
    inv: parseHerdrArgs([], invocationFlags({ "panel-width": "42" })),
    left: "/usr/bin/herdr",
    right: "/tui --overview",
    env: { AIS_CONSOLE_URL: "http://127.0.0.1:47129", AIS_CONSOLE_TOKEN: "t" },
    cols: 200,
    rows: 50,
  });

  test("the session is created detached on the left with herdr", () => {
    expect(steps[0]!.label).toBe("new-session");
    expect(steps[0]!.args).toEqual([
      "new-session",
      "-d",
      "-s",
      HERDR_SESSION,
      "-n",
      HERDR_SESSION,
      "-x",
      "200",
      "-y",
      "50",
      "/usr/bin/herdr",
    ]);
  });

  test("remain-on-exit keeps an honest failure visible in the herdr pane", () => {
    expect(steps[1]!.args).toEqual([
      "set-option",
      "-w",
      "-t",
      `${HERDR_SESSION}:0`,
      "remain-on-exit",
      "on",
    ]);
  });

  test("console credentials ride the session environment, never argv", () => {
    const setenvs = steps.filter((step) => step.label.startsWith("set-environment"));
    expect(setenvs.map((step) => step.args)).toEqual([
      ["set-environment", "-t", HERDR_SESSION, "AIS_CONSOLE_URL", "http://127.0.0.1:47129"],
      ["set-environment", "-t", HERDR_SESSION, "AIS_CONSOLE_TOKEN", "t"],
    ]);
  });

  test("the panel splits off the right edge at the panel width; focus stays on herdr", () => {
    const split = steps.find((step) => step.label === "split-window")!;
    expect(split.args).toEqual([
      "split-window",
      "-h",
      "-d",
      "-t",
      `${HERDR_SESSION}:0.0`,
      "-l",
      "42",
      "/tui --overview",
    ]);
    const select = steps.find((step) => step.label === "select-pane")!;
    expect(select.args).toEqual(["select-pane", "-t", `${HERDR_SESSION}:0.0`]);
  });
});

describe("remote console plumbing", () => {
  test("parseRemoteConsoleState is tolerant and never invents values", () => {
    expect(parseRemoteConsoleState("not json")).toEqual({});
    expect(parseRemoteConsoleState("{}")).toEqual({});
    expect(parseRemoteConsoleState('{"port": "47129"}')).toEqual({});
    expect(parseRemoteConsoleState('{"port": 47129, "token": "t", "pid": 9}')).toEqual({
      port: 47129,
      token: "t",
    });
  });

  test("ssh reads are non-interactive; the tunnel forwards loopback only", () => {
    expect(remoteStateArgs("box")).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "box",
      "cat",
      "~/.ais/web/server.json",
    ]);
    expect(tunnelArgs("box", 40001, 47129)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "127.0.0.1:40001:127.0.0.1:47129",
      "box",
    ]);
  });
});

/* ------------------------------ command runner ----------------------------- */

interface TmuxHarness {
  tmux: string[][];
  attaches: string[][];
  raw: string[][];
  logs: string[];
  deps(overrides?: Partial<HerdrCommandDeps>): HerdrCommandDeps;
}

function tmuxHarness(env: NodeJS.ProcessEnv = {}, sessionExists = false): TmuxHarness {
  const tmux: string[][] = [];
  const attaches: string[][] = [];
  const raw: string[][] = [];
  const logs: string[] = [];
  return {
    tmux,
    attaches,
    raw,
    logs,
    deps(overrides: Partial<HerdrCommandDeps> = {}): HerdrCommandDeps {
      return {
        env,
        isInteractive: () => false,
        terminalSize: () => ({ cols: 200, rows: 50 }),
        tmuxPath: () => "/usr/bin/tmux",
        herdrPath: () => "/usr/bin/herdr",
        tuiPath: () => "/usr/local/bin/aistui",
        aisEntrypoint: async () => ["/usr/local/bin/ais"],
        consoleUrl: async () => "http://127.0.0.1:47129",
        consoleToken: async () => "sekrit-token",
        runTmux: async (args) => {
          tmux.push(args);
          // First call is has-session when simulating an existing session.
          if (args[0] === "has-session") {
            return { exitCode: sessionExists ? 0 : 1, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        attach: async (args) => {
          attaches.push(args);
          return 0;
        },
        execRaw: async (_command, args) => {
          raw.push(args);
          return 0;
        },
        log: (message) => logs.push(message),
        ...overrides,
      };
    },
  };
}

describe("runHerdrCommand", () => {
  test("--raw execs plain herdr with no tmux at all (and honours --remote)", async () => {
    const h = tmuxHarness();
    await runHerdrCommand([], invocationFlags({ raw: true }), h.deps());
    expect(h.raw).toEqual([[]]);
    expect(h.tmux).toEqual([]);
    await runHerdrCommand([], invocationFlags({ raw: true, remote: "box" }), h.deps());
    expect(h.raw[1]).toEqual(["--remote", "box"]);
  });

  test("missing herdr explains the never-bundled rule and points at ais upgrade", async () => {
    const h = tmuxHarness();
    h.deps().herdrPath = () => null;
    await expect(
      runHerdrCommand([], invocationFlags(), { ...h.deps(), herdrPath: () => null }),
    ).rejects.toThrow(/ais upgrade/);
  });

  test("the nesting guard refuses inside tmux/herdr and --force overrides it", async () => {
    const h = tmuxHarness({ TMUX: "/tmp/tmux-0/default,1,0" });
    await expect(runHerdrCommand([], invocationFlags(), h.deps())).rejects.toThrow(/nest|--force/);
    const forced = tmuxHarness({ TMUX: "/tmp/tmux-0/default,1,0" });
    await runHerdrCommand([], invocationFlags({ force: true }), forced.deps());
    expect(forced.tmux.some((args) => args[0] === "new-session")).toBe(true);
    const insideHerdr = tmuxHarness({ HERDR_PANE_ID: "w1:p1" });
    await expect(runHerdrCommand([], invocationFlags(), insideHerdr.deps())).rejects.toThrow(/herdr pane/);
  });

  test("missing tmux is its own error", async () => {
    const h = tmuxHarness();
    await expect(runHerdrCommand([], invocationFlags(), { ...h.deps(), tmuxPath: () => null })).rejects.toThrow(
      /tmux/,
    );
  });

  test("create: full tmux sequence with console env and the overview panel", async () => {
    const h = tmuxHarness();
    await runHerdrCommand([], invocationFlags(), h.deps());
    const labels = h.tmux.map((args) => args[0]);
    expect(labels[0]).toBe("has-session");
    expect(labels).toContain("new-session");
    expect(labels).toContain("split-window");
    expect(labels).toContain("select-pane");
    // Console credentials via set-environment, never argv.
    const setenv = h.tmux.find((args) => args[0] === "set-environment" && args[3] === "AIS_CONSOLE_TOKEN");
    expect(setenv![4]).toBe("sekrit-token");
    // Right pane is the overview; left pane is the plain herdr client.
    const split = h.tmux.find((args) => args[0] === "split-window")!;
    expect(split.at(-1)).toBe("/usr/local/bin/aistui --overview");
    const create = h.tmux.find((args) => args[0] === "new-session")!;
    expect(create.at(-1)).toBe("/usr/bin/herdr");
    // Non-interactive stdin: no attach, session left detached with a hint.
    expect(h.attaches).toEqual([]);
    expect(h.logs.join("\n")).toContain("created detached");
  });

  test("an existing session is attached, not duplicated", async () => {
    const h = tmuxHarness({}, true);
    await runHerdrCommand([], invocationFlags(), h.deps());
    expect(h.tmux.map((args) => args[0])).toEqual(["has-session"]);
    expect(h.attaches).toEqual([["attach-session", "-t", HERDR_SESSION]]);
    expect(h.tmux.some((args) => args[0] === "new-session")).toBe(false);
  });

  test("--new recreates: kills the old session first, then builds a fresh one", async () => {
    const h = tmuxHarness({}, true);
    await runHerdrCommand([], invocationFlags({ new: true }), h.deps());
    const labels = h.tmux.map((args) => args[0]);
    expect(labels[0]).toBe("has-session");
    expect(labels[1]).toBe("kill-session");
    expect(labels).toContain("new-session");
  });

  test("remote without --remote-ais: herdr gets --remote, panel shows local data with highlighting honestly off", async () => {
    const h = tmuxHarness();
    await runHerdrCommand([], invocationFlags({ remote: "box.example" }), h.deps());
    const create = h.tmux.find((args) => args[0] === "new-session")!;
    expect(create.at(-1)).toBe("/usr/bin/herdr --remote box.example");
    const split = h.tmux.find((args) => args[0] === "split-window")!;
    expect(split.at(-1)).toBe("/usr/local/bin/aistui --overview");
    const names = h.tmux.filter((args) => args[0] === "set-environment").map((args) => args[3]);
    expect(names).toContain("AIS_OVERVIEW_BRIDGE");
    expect(names).toContain("AIS_OVERVIEW_NOTE");
    expect(names).toContain("AIS_OVERVIEW_LABEL");
    const bridge = h.tmux.find((args) => args[0] === "set-environment" && args[3] === "AIS_OVERVIEW_BRIDGE")!;
    expect(bridge[4]).toBe("off");
  });

  test("remote-ais: the right pane is the hidden panel subcommand and no local env is forced", async () => {
    const h = tmuxHarness();
    await runHerdrCommand([], invocationFlags({ remote: "box", "remote-ais": true }), h.deps());
    const split = h.tmux.find((args) => args[0] === "split-window")!;
    expect(split.at(-1)).toBe("/usr/local/bin/ais __herdr_panel --remote=box");
    const names = h.tmux.filter((args) => args[0] === "set-environment").map((args) => args[3]);
    expect(names).not.toContain("AIS_OVERVIEW_BRIDGE");
    expect(names).not.toContain("AIS_CONSOLE_TOKEN");
  });

  test("interactive stdin attaches after creating", async () => {
    const h = tmuxHarness();
    await runHerdrCommand([], invocationFlags(), { ...h.deps(), isInteractive: () => true });
    expect(h.attaches).toEqual([["attach-session", "-t", HERDR_SESSION]]);
    expect(h.logs).toEqual([]);
  });

  test("--tmux-socket rides every tmux invocation", async () => {
    const h = tmuxHarness({}, true);
    await runHerdrCommand([], invocationFlags({ "tmux-socket": "ais-test" }), h.deps());
    expect(h.tmux[0]).toEqual(["-L", "ais-test", "has-session", "-t", HERDR_SESSION]);
    expect(h.attaches[0]).toEqual(["-L", "ais-test", "attach-session", "-t", HERDR_SESSION]);
  });

  test("the AIS_TMUX_SOCKET env var is honoured like the flag (dispatch passes flags only)", () => {
    // The env fallback is resolved by the command layer in dispatch; here we
    // just pin the documented flag behaviour end to end.
    const parsed = parseHerdrArgs([], invocationFlags({ "tmux-socket": "ais-test" }));
    expect(hasSessionArgs(parsed.tmuxSocket)[0]).toBe("-L");
  });
});

/* ------------------------------ panel subcommand --------------------------- */

interface PanelHarness {
  ssh: string[][];
  tunnels: Array<{ local: number; remote: number; killed: boolean }>;
  tuiRuns: Array<{ bin: string; env: Record<string, string> }>;
  logs: string[];
  deps(overrides?: Partial<HerdrPanelDeps>): HerdrPanelDeps;
}

function panelHarness(remoteState = "{}", verifies = true): PanelHarness {
  const ssh: string[][] = [];
  const tunnels: Array<{ local: number; remote: number; killed: boolean }> = [];
  const tuiRuns: Array<{ bin: string; env: Record<string, string> }> = [];
  const logs: string[] = [];
  return {
    ssh,
    tunnels,
    tuiRuns,
    logs,
    deps(overrides: Partial<HerdrPanelDeps> = {}): HerdrPanelDeps {
      return {
        log: (message) => logs.push(message),
        readRemoteState: async (_target) => {
          ssh.push([_target]);
          return remoteState;
        },
        pickFreePort: async () => 40001,
        spawnTunnel: (_target, localPort, remotePort) => {
          const entry = { local: localPort, remote: remotePort, killed: false };
          tunnels.push(entry);
          return {
            kill: () => {
              entry.killed = true;
            },
          };
        },
        verifyTunnel: async () => verifies,
        localConsole: async () => ({ url: "http://127.0.0.1:47129", token: "local-token" }),
        tuiPath: () => "/usr/local/bin/aistui",
        runTui: async (bin, env) => {
          tuiRuns.push({ bin, env });
          return 0;
        },
        ...overrides,
      };
    },
  };
}

describe("runHerdrPanelCommand", () => {
  test("--remote is required (hidden command, still guarded)", async () => {
    const h = panelHarness();
    await expect(runHerdrPanelCommand([], {}, h.deps())).rejects.toThrow(/--remote/);
  });

  test("a working remote console: aistui talks to the tunnel with the remote token, tunnel cleaned up on exit", async () => {
    const h = panelHarness('{"port": 47129, "token": "remote-token"}', true);
    await runHerdrPanelCommand([], { remote: "box" }, h.deps());
    expect(h.tunnels).toEqual([{ local: 40001, remote: 47129, killed: true }]);
    expect(h.tuiRuns).toHaveLength(1);
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_URL).toBe("http://127.0.0.1:40001");
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_TOKEN).toBe("remote-token");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_LABEL).toBe("remote:box");
    // Highlights come from the REMOTE bridge, which IS the left pane's server.
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBeUndefined();
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toBeUndefined();
  });

  test("a remote without ais: honest fallback to local data, tunnel torn down, note shown", async () => {
    const h = panelHarness('{"pid": 123}', false); // server.json without a port
    await runHerdrPanelCommand([], { remote: "box" }, h.deps());
    expect(h.tunnels).toEqual([]);
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_URL).toBe("http://127.0.0.1:47129");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBe("off");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("box");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("LOCAL");
  });

  test("an unreachable tunnelled console tears the tunnel down and degrades to local", async () => {
    const h = panelHarness('{"port": 47129, "token": "t"}', false);
    await runHerdrPanelCommand([], { remote: "box" }, h.deps());
    expect(h.tunnels).toEqual([{ local: 40001, remote: 47129, killed: true }]);
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBe("off");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("no reachable ais console");
  });

  test("an ssh failure (e.g. target without ais entirely) is surfaced and degraded honestly", async () => {
    const h = panelHarness();
    const deps = h.deps();
    deps.readRemoteState = async () => {
      throw new Error("ssh: connect to host box port 22: Connection refused");
    };
    await runHerdrPanelCommand([], { remote: "box" }, deps);
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBe("off");
    expect(h.logs.join("\n")).toContain("no readable ais console state");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("LOCAL");
  });
});
