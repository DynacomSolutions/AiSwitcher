import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAndInstallAgentGuard, installAgentGuardForHome, agentGuardInstaller } from "../../src/identities/agent-guard-install.ts";
import { runT3InstanceCommand } from "../../src/cli/gateway/t3-instance.ts";

type Call = { command: string; args: string[] };
const fake = (codes: number[], calls: Call[]) => async (command: string, args: string[]) => {
  calls.push({ command, args });
  return { exitCode: codes.shift() ?? 0, stdout: "", stderr: "boom detail" };
};

describe("agent-guard install helpers", () => {
  test("home install passes --only with the driver and resolves the installer from home", async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    await installAgentGuardForHome("opencode", { home: "/h", run: fake([0], calls), exists: () => true, log: (l) => lines.push(l) });
    expect(calls).toEqual([{ command: agentGuardInstaller("/h"), args: ["--only", "opencode"] }]);
    expect(calls[0]!.command).toBe("/h/.ais/agent-guard/install.sh");
  });

  test("a missing installer is skipped with one log line", async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    await installAgentGuardForHome("grok", { run: fake([0], calls), exists: () => false, log: (l) => lines.push(l) });
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skipped");
  });

  test("an installer failure or crash warns and never throws", async () => {
    const lines: string[] = [];
    await installAgentGuardForHome("grok", { run: fake([3], []), exists: () => true, log: (l) => lines.push(l) });
    await installAgentGuardForHome("grok", { run: async () => { throw new Error("spawn failed"); }, exists: () => true, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("warning");
    expect(lines[0]).toContain("exit 3");
    expect(lines[1]).toContain("spawn failed");
  });

  test("update runs check, and installs only when the check fails", async () => {
    const clean: Call[] = [];
    expect(await checkAndInstallAgentGuard({ run: fake([0], clean), exists: () => true, log: () => {} })).toContain("up to date");
    expect(clean.map((c) => c.args)).toEqual([["--check"]]);

    const stale: Call[] = [];
    expect(await checkAndInstallAgentGuard({ run: fake([1, 0], stale), exists: () => true, log: () => {} })).toContain("installed");
    expect(stale.map((c) => c.args)).toEqual([["--check"], []]);

    expect(await checkAndInstallAgentGuard({ run: fake([1, 2], []), exists: () => true, log: () => {} })).toContain("warning");
    expect(await checkAndInstallAgentGuard({ run: fake([], []), exists: () => false, log: () => {} })).toBeUndefined();
  });
});

describe("ais gateway t3-instance", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agent-guard-cmd-"));
    await mkdir(join(home, ".t3", "userdata"), { recursive: true });
    await writeFile(join(home, "secrets"), "AIS_GATEWAY_PROXY_URL=https://gw.example/gateway\nAIS_GATEWAY_APP_OC_TOKEN=aisg_testtoken123\n");
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const deps = (out: string[]) => ({ out: (l: string) => out.push(l), secretsPath: join(home, "secrets") }) as never;

  test("creating a home runs the installer for that tool, and a failure keeps the command successful", async () => {
    const calls: Call[] = [];
    const out: string[] = [];
    await runT3InstanceCommand(["oc1"], { driver: "opencode", app: "oc" }, deps(out), { home, env: {} }, { run: fake([0], calls), exists: () => true });
    expect(calls.map((c) => c.args)).toEqual([["--only", "opencode"]]);

    const out2: string[] = [];
    await runT3InstanceCommand(["oc1"], { driver: "opencode", app: "oc" }, deps(out2), { home, env: {} }, { run: fake([5], []), exists: () => true });
    expect(out2.join("\n")).toContain("warning: install for opencode failed");
  });

  test("--check does not run the installer", async () => {
    const calls: Call[] = [];
    await runT3InstanceCommand(["oc1"], { driver: "opencode", app: "oc" }, deps([]), { home, env: {} }, { run: fake([0], calls), exists: () => true });
    calls.length = 0;
    await runT3InstanceCommand(["oc1"], { driver: "opencode", app: "oc", check: true }, deps([]), { home, env: {} }, { run: fake([0], calls), exists: () => true });
    expect(calls).toHaveLength(0);
  });
});
