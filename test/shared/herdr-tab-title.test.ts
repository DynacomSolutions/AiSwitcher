import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrTabTitleWatcher, formatHerdrChatTitle } from "../../src/shared/herdr-tab-title.ts";

describe("Herdr chat tab titles", () => {
  test("cleans controls, bounds length, and rejects command-only prompts", () => {
    expect(formatHerdrChatTitle("\u001b[31mFix the \u0000 router\u001b[0m")).toBe("Fix the router");
    expect(formatHerdrChatTitle("status")).toBeUndefined();
    expect(formatHerdrChatTitle("a meaningful request that is longer than sixty four characters and should be shortened"))
      .toHaveLength(62);
  });

  test("pins only the wrapper-owned pane, renames it from exact session content, and stops after a manual rename", async () => {
    let label = "7";
    let panes: unknown[] = [];
    const commands: string[][] = [];
    const runHerdr = async (args: string[]) => {
      commands.push(args);
      if (args[0] === "pane" && args[1] === "current") {
        return { ok: true, stdout: JSON.stringify({ result: { pane: { pane_id: "own", tab_id: "tab-own" } } }) };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        return { ok: true, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 42 }] } } }) };
      }
      if (args[0] === "pane" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { panes } }) };
      if (args[0] === "tab" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { tabs: [
        { tab_id: "tab-own", label, number: 7 }, { tab_id: "other", label: "8", number: 8 },
      ] } }) };
      if (args[0] === "tab" && args[1] === "rename") { label = args[3] ?? ""; return { ok: true, stdout: "" }; }
      return { ok: false, stdout: "" };
    };
    panes = [
      { pane_id: "other-pane", tab_id: "other", agent: "claude", agent_session: { agent: "claude", kind: "id", value: "unrelated" } },
      { pane_id: "own", tab_id: "tab-own", agent: "claude", agent_session: { agent: "claude", kind: "id", value: "session-1" } },
    ];
    const watcher = new HerdrTabTitleWatcher({
      agent: "claude", tool: "claude", configDir: "/synthetic/config", cwd: "/synthetic/project", pid: 42,
      runHerdr,
      readTitle: async (_tool, _config, _cwd, session) => session.value === "session-1" ? "Repair the router tests" : null,
    });
    await watcher.start();
    expect(commands.some((args) => args[0] === "tab" && args[1] === "rename" && args[2] === "tab-own" && args[3] === "Repair the router tests")).toBe(true);
    expect(commands.some((args) => args[0] === "pane" && args[1] === "current")).toBe(true);
    expect(commands.filter((args) => args[0] === "pane" && args[1] === "current")).toHaveLength(1);

    label = "My manual name";
    await watcher.pollOnce();
    label = "Repair the router tests";
    await watcher.pollOnce();
    expect(commands.filter((args) => args[0] === "tab" && args[1] === "rename")).toHaveLength(1);
    watcher.stop();
  });

  test("does not take ownership without process proof or overwrites a custom tab", async () => {
    let renameCount = 0;
    let label = "Research";
    const runHerdr = async (args: string[]) => {
      if (args[0] === "pane" && args[1] === "current") return { ok: true, stdout: JSON.stringify({ result: { pane: { pane_id: "p", tab_id: "t" } } }) };
      if (args[0] === "pane" && args[1] === "process-info") return { ok: true, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 99 }] } } }) };
      if (args[0] === "tab" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { tabs: [{ tab_id: "t", label, number: 2 }] } }) };
      if (args[0] === "pane" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { panes: [{ pane_id: "p", tab_id: "t", agent: "codex", agent_session: { agent: "codex", kind: "id", value: "s" } }] } }) };
      if (args[0] === "tab" && args[1] === "rename") renameCount += 1;
      return { ok: true, stdout: "" };
    };
    const watcher = new HerdrTabTitleWatcher({ agent: "codex", tool: "codex", configDir: "/synthetic", cwd: "/synthetic", pid: 42, runHerdr, readTitle: async () => "A useful title" });
    await watcher.start();
    expect(renameCount).toBe(0);
    watcher.stop();
  });

  test("does not rename after the wrapper stops while a transcript read is pending", async () => {
    let resolveTitle!: (value: string | null) => void;
    let titleReadStarted!: () => void;
    const started = new Promise<void>((resolve) => { titleReadStarted = resolve; });
    const pendingTitle = new Promise<string | null>((resolve) => { resolveTitle = resolve; });
    let renameCount = 0;
    const runHerdr = async (args: string[]) => {
      if (args[0] === "pane" && args[1] === "current") return { ok: true, stdout: JSON.stringify({ result: { pane: { pane_id: "p", tab_id: "t" } } }) };
      if (args[0] === "pane" && args[1] === "process-info") return { ok: true, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 42 }] } } }) };
      if (args[0] === "tab" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { tabs: [{ tab_id: "t", label: "3", number: 3 }] } }) };
      if (args[0] === "pane" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { panes: [{ pane_id: "p", tab_id: "t", agent: "claude", agent_session: { agent: "claude", kind: "id", value: "s" } }] } }) };
      if (args[0] === "tab" && args[1] === "rename") renameCount += 1;
      return { ok: true, stdout: "" };
    };
    const watcher = new HerdrTabTitleWatcher({
      agent: "claude", tool: "claude", configDir: "/synthetic", cwd: "/synthetic", pid: 42, runHerdr,
      readTitle: async () => { titleReadStarted(); return pendingTitle; },
    });
    const starting = watcher.start();
    await started;
    watcher.stop();
    resolveTitle("A title after shutdown");
    await starting;
    expect(renameCount).toBe(0);
  });

  function harness(label: string, tabId = "t") {
    const state = { label, renames: [] as string[] };
    const runHerdr = async (args: string[]) => {
      if (args[0] === "pane" && args[1] === "current") return { ok: true, stdout: JSON.stringify({ result: { pane: { pane_id: "p", tab_id: tabId } } }) };
      if (args[0] === "pane" && args[1] === "process-info") return { ok: true, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 42 }] } } }) };
      if (args[0] === "tab" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { tabs: [{ tab_id: tabId, label: state.label, number: 3 }] } }) };
      if (args[0] === "pane" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ result: { panes: [{ pane_id: "p", tab_id: tabId, agent: "claude", agent_session: { agent: "claude", kind: "id", value: "s" } }] } }) };
      if (args[0] === "tab" && args[1] === "rename") { state.label = args[3] ?? ""; state.renames.push(state.label); }
      return { ok: true, stdout: "" };
    };
    return { state, runHerdr };
  }
  const make = (h: ReturnType<typeof harness>, statePath: string, title: string) =>
    new HerdrTabTitleWatcher({ agent: "claude", tool: "claude", configDir: "/s", cwd: "/s", pid: 42, runHerdr: h.runHerdr, statePath, readTitle: async () => title });

  test("persists automatic labels and a resumed watcher keeps renaming that tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-herdr-state-"));
    const statePath = join(dir, "labels.json");
    const h = harness("3");
    const first = make(h, statePath, "First generated title");
    await first.start();
    first.stop();
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ t: "First generated title" });

    const resumed = make(h, statePath, "Second generated title");
    await resumed.start();
    resumed.stop();
    expect(h.state.renames).toEqual(["First generated title", "Second generated title"]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ t: "Second generated title" });
  });

  test("a manual label differing from persisted state still blocks renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-herdr-state-"));
    const statePath = join(dir, "labels.json");
    await writeFile(statePath, JSON.stringify({ t: "Old automatic title" }));
    const h = harness("My manual name");
    const watcher = make(h, statePath, "Fresh title");
    await watcher.start();
    watcher.stop();
    expect(h.state.renames).toEqual([]);
  });

  test("tolerates a corrupt state file and prunes tab ids that no longer exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-herdr-state-"));
    const statePath = join(dir, "labels.json");
    await writeFile(statePath, "{not json");
    const h = harness("3");
    const a = make(h, statePath, "Title after corruption");
    await a.start();
    a.stop();
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ t: "Title after corruption" });
    await writeFile(statePath, JSON.stringify({ t: "Title after corruption", gone: "Stale tab title" }));
    h.state.label = "Title after corruption";
    const b = make(h, statePath, "Another title");
    await b.start();
    b.stop();
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ t: "Another title" });
  });
});
