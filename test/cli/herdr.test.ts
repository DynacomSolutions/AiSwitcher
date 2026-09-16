import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PANEL_WIDTH,
  REMOVED_TMUX_FLAGS,
  insideHerdrPane,
  nestingConflict,
  parseHerdrArgs,
  parseRemoteConsoleState,
  remoteStateArgs,
  runHerdrCommand,
  tunnelArgs,
  wrapperArgv,
  type HerdrCommandDeps,
} from "../../src/cli/herdr.ts";
import { CliUsageError } from "../../src/cli/errors.ts";

function invocationFlags(overrides: Record<string, string | true> = {}): Record<string, string | true> {
  return { ...overrides };
}

describe("parseHerdrArgs", () => {
  test("defaults: no raw/force/remote, width 42", () => {
    expect(parseHerdrArgs([], invocationFlags())).toEqual({
      raw: false,
      force: false,
      remoteAis: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
    });
  });

  test("accepts the documented flags", () => {
    const parsed = parseHerdrArgs(
      [],
      invocationFlags({ raw: true, force: true, "remote-ais": true, remote: "box", "panel-width": "38" }),
    );
    expect(parsed).toEqual({
      raw: true,
      force: true,
      remote: "box",
      remoteAis: true,
      panelWidth: 38,
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

  test("the tmux-era flags are gone, each with an honest explanation", () => {
    for (const flag of Object.keys(REMOVED_TMUX_FLAGS)) {
      expect(() => parseHerdrArgs([], invocationFlags({ [flag]: true }))).toThrow(
        /no longer uses tmux/,
      );
      expect(() => parseHerdrArgs([], invocationFlags({ [flag]: "value" }))).toThrow(
        new RegExp(`--${flag} is gone`),
      );
    }
    // And the message for --new explains what to do instead.
    expect(() => parseHerdrArgs([], invocationFlags({ new: true }))).toThrow(/foreground TUI/);
    expect(() => parseHerdrArgs([], invocationFlags({ "panel-cmd": "htop" }))).toThrow(
      /rendered natively by aistui/,
    );
  });
});

describe("nestingConflict", () => {
  test("HERDR_* vars mean herdr; clean env passes", () => {
    expect(nestingConflict({ HERDR_PANE_ID: "w1:p1" })).toBe("herdr");
    expect(nestingConflict({ PATH: "/usr/bin" })).toBeUndefined();
  });

  test("tmux is NOT a conflict: the native wrapper is a plain TUI and nests fine", () => {
    expect(nestingConflict({ TMUX: "/tmp/tmux-0/default,1,0" })).toBeUndefined();
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

/* --------------------------------- plumbing -------------------------------- */

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

describe("wrapperArgv", () => {
  test("subcommand first, resolved herdr path, panel width", () => {
    const inv = parseHerdrArgs([], invocationFlags());
    expect(wrapperArgv({ herdrPath: "/usr/bin/herdr", inv })).toEqual([
      "herdr",
      "--herdr-bin",
      "/usr/bin/herdr",
      "--panel-width",
      "42",
    ]);
  });

  test("--remote rides as the passthrough flag pair", () => {
    const inv = parseHerdrArgs([], invocationFlags({ remote: "herdr.example", "panel-width": "38" }));
    expect(wrapperArgv({ herdrPath: "/opt/bin/herdr", inv })).toEqual([
      "herdr",
      "--herdr-bin",
      "/opt/bin/herdr",
      "--panel-width",
      "38",
      "--remote",
      "herdr.example",
    ]);
  });
});

/* ------------------------------- command runner ----------------------------- */

interface Harness {
  tuiRuns: Array<{ argv: string[]; env: Record<string, string> }>;
  raw: string[][];
  tunnels: Array<{ local: number; remote: number; killed: boolean }>;
  logs: string[];
  consoleEnsured: number;
  deps(overrides?: Partial<HerdrCommandDeps>): HerdrCommandDeps;
}

function harness(env: NodeJS.ProcessEnv = {}): Harness {
  const tuiRuns: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const raw: string[][] = [];
  const tunnels: Array<{ local: number; remote: number; killed: boolean }> = [];
  const logs: string[] = [];
  let consoleEnsured = 0;
  return {
    tuiRuns,
    raw,
    tunnels,
    logs,
    get consoleEnsured() {
      return consoleEnsured;
    },
    deps(overrides: Partial<HerdrCommandDeps> = {}): HerdrCommandDeps {
      return {
        env,
        isInteractive: () => true,
        herdrPath: () => "/usr/bin/herdr",
        tuiPath: () => "/usr/local/bin/aistui",
        consoleUrl: async () => {
          consoleEnsured++;
          return "http://127.0.0.1:47129";
        },
        consoleToken: async () => "sekrit-token",
        readRemoteState: async (_target) => {
          void _target;
          return "{}";
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
        verifyTunnel: async () => true,
        runAistui: async (argv, runEnv) => {
          tuiRuns.push({ argv, env: runEnv });
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
  test("--raw execs plain herdr with no wrapper (and honours --remote)", async () => {
    const h = harness();
    await runHerdrCommand(["--raw"], h.deps());
    expect(h.raw).toEqual([[]]);
    expect(h.tuiRuns).toEqual([]);
    await runHerdrCommand(["--raw", "--remote=box"], h.deps());
    expect(h.raw[1]).toEqual(["--remote", "box"]);
  });

  test("missing herdr explains the never-bundled rule and points at ais upgrade", async () => {
    const h = harness();
    await expect(
      runHerdrCommand([], { ...h.deps(), herdrPath: () => null }),
    ).rejects.toThrow(/ais upgrade/);
  });

  test("non-interactive stdin is refused before any side effects", async () => {
    const h = harness();
    await expect(
      runHerdrCommand([], { ...h.deps(), isInteractive: () => false }),
    ).rejects.toThrow(/needs a terminal/);
    expect(h.consoleEnsured).toBe(0);
    expect(h.tuiRuns).toEqual([]);
  });

  test("the nesting guard refuses inside a herdr pane; --force overrides it", async () => {
    const h = harness({ HERDR_PANE_ID: "w1:p1" });
    await expect(runHerdrCommand([], h.deps())).rejects.toThrow(/herdr pane|--force/);
    const forced = harness({ HERDR_PANE_ID: "w1:p1" });
    await runHerdrCommand(["--force"], forced.deps());
    expect(forced.tuiRuns).toHaveLength(1);
  });

  test("plain mode: console ensured, env carries credentials, aistui herdr runs in the foreground", async () => {
    const h = harness();
    await runHerdrCommand([], h.deps());
    expect(h.tuiRuns).toEqual([
      {
        argv: ["/usr/local/bin/aistui", "herdr", "--herdr-bin", "/usr/bin/herdr", "--panel-width", "42"],
        env: {
          AIS_CONSOLE_URL: "http://127.0.0.1:47129",
          AIS_CONSOLE_TOKEN: "sekrit-token",
        },
      },
    ]);
    expect(h.tunnels).toEqual([]);
  });

  test("space form folds: --remote box --panel-width 38", async () => {
    const h = harness();
    await runHerdrCommand(["--remote", "box.example", "--panel-width", "38"], h.deps());
    expect(h.tuiRuns[0]!.argv).toEqual([
      "/usr/local/bin/aistui",
      "herdr",
      "--herdr-bin",
      "/usr/bin/herdr",
      "--panel-width",
      "38",
      "--remote",
      "box.example",
    ]);
  });

  test("a bare valued flag with no value keeps its requires-a-value error", async () => {
    await expect(runHerdrCommand(["--remote"], harness().deps())).rejects.toThrow(
      /--remote requires a value/,
    );
  });

  test("a following boolean flag is never eaten as a space-form value", async () => {
    await expect(runHerdrCommand(["--remote", "--raw"], harness().deps())).rejects.toThrow(
      /--remote requires a value/,
    );
  });

  test("an unknown positional after space-form flags still fails", async () => {
    const h = harness();
    await expect(runHerdrCommand(["--remote", "box.example", "junk"], h.deps())).rejects.toThrow(
      /takes no positionals/,
    );
    expect(h.tuiRuns).toEqual([]);
  });

  test("--remote without --remote-ais: child gets --remote, panel shows local data with highlighting honestly off", async () => {
    const h = harness();
    await runHerdrCommand(["--remote", "box.example"], h.deps());
    expect(h.tuiRuns[0]!.argv.at(-1)).toBe("box.example");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_LABEL).toBe("remote:box.example");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBe("off");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("no highlight source");
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_URL).toBe("http://127.0.0.1:47129");
    expect(h.tunnels).toEqual([]);
  });

  test("--remote-ais success: tunnel mirrors the remote console, remote token replaces local, tunnel killed on exit", async () => {
    const h = harness();
    const deps = h.deps();
    deps.readRemoteState = async () => '{"port": 47129, "token": "remote-token"}';
    await runHerdrCommand(["--remote=box", "--remote-ais"], deps);
    expect(h.tunnels).toEqual([{ local: 40001, remote: 47129, killed: true }]);
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_URL).toBe("http://127.0.0.1:40001");
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_TOKEN).toBe("remote-token");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_LABEL).toBe("remote:box");
    // Highlights come from the REMOTE bridge, which IS the left pane's server.
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBeUndefined();
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toBeUndefined();
  });

  test("--remote-ais with a tokenless remote console: the local token must not leak to it", async () => {
    const h = harness();
    const deps = h.deps();
    deps.readRemoteState = async () => '{"port": 47129}';
    await runHerdrCommand(["--remote=box", "--remote-ais"], deps);
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_TOKEN).toBeUndefined();
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_URL).toBe("http://127.0.0.1:40001");
  });

  test("a remote whose tunnel never verifies: honest local fallback, note shown, tunnel torn down", async () => {
    const h = harness();
    const deps = h.deps();
    deps.readRemoteState = async () => '{"port": 47129, "token": "t"}';
    deps.verifyTunnel = async () => false;
    await runHerdrCommand(["--remote=box", "--remote-ais"], deps);
    expect(h.tunnels).toEqual([{ local: 40001, remote: 47129, killed: true }]);
    expect(h.tuiRuns[0]!.env.AIS_CONSOLE_URL).toBe("http://127.0.0.1:47129");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBe("off");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("no reachable ais console");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("LOCAL");
  });

  test("an ssh failure (e.g. target without ais entirely) is surfaced and degraded honestly", async () => {
    const h = harness();
    const deps = h.deps();
    deps.readRemoteState = async () => {
      throw new Error("ssh: connect to host box port 22: Connection refused");
    };
    await runHerdrCommand(["--remote=box", "--remote-ais"], deps);
    expect(h.tunnels).toEqual([]);
    expect(h.logs.join("\n")).toContain("no readable ais console state");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_BRIDGE).toBe("off");
    expect(h.tuiRuns[0]!.env.AIS_OVERVIEW_NOTE).toContain("LOCAL");
  });

  test("the tunnel is killed even when aistui exits non-zero (finally, not happy path)", async () => {
    const h = harness();
    const deps = h.deps();
    deps.readRemoteState = async () => '{"port": 47129, "token": "t"}';
    deps.runAistui = async (argv, env) => {
      h.tuiRuns.push({ argv, env });
      return 3;
    };
    // Stub process.exit so the non-zero propagation is observable without
    // killing the test runner.
    const realExit = process.exit;
    let exitCode: number | undefined;
    (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`exit ${code}`);
    }) as (code?: number) => never;
    try {
      await expect(runHerdrCommand(["--remote=box", "--remote-ais"], deps)).rejects.toThrow(
        /exit 3/,
      );
    } finally {
      process.exit = realExit;
    }
    expect(exitCode).toBe(3);
    expect(h.tunnels).toEqual([{ local: 40001, remote: 47129, killed: true }]);
  });

  test("aistui self-heal: a missing binary downloads once from the release before launching", async () => {
    const h = harness();
    let healCalls = 0;
    await runHerdrCommand(
      [],
      h.deps({
        tuiPath: () => null,
        ensureTuiPath: async () => {
          healCalls++;
          return "/home/user/.local/bin/aistui";
        },
      }),
    );
    expect(healCalls).toBe(1);
    expect(h.tuiRuns[0]!.argv[0]).toBe("/home/user/.local/bin/aistui");
  });

  test("aistui unresolvable even after self-heal: error names both the build and the download failure", async () => {
    const h = harness();
    await expect(
      runHerdrCommand(
        [],
        h.deps({
          tuiPath: () => null,
          ensureTuiPath: async () => {
            throw new Error("no network");
          },
        }),
      ),
    ).rejects.toThrow(/no network[\s\S]*cargo build --release/);
    expect(h.tuiRuns).toEqual([]);
  });
});
