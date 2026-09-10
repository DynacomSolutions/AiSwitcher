import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_CONFIG } from "../../src/identities/tool-configs.ts";
import { codexSubcommandConfigArgs } from "../../src/shared/codex-config-args.ts";
import { projectSharedCodexConfigForLaunch } from "../../src/shared/codex-shared-config.ts";
import { projectGlobalMemoryForLaunch } from "../../src/shared/global-memory.ts";

// Explicit opt-in uses the installed native binary, never the AIS wrapper.
// All config/state and environment are disposable; no credentials or model calls.
const native = process.env.AIS_TEST_CODEX_BINARY;
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ais-codex-native-config-"));
  homes.push(home);
  const identity = join(home, ".codex", "identities", "test");
  await mkdir(identity, { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), `
model = "shared-model"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
[features]
hooks = true
[mcp_servers.graph]
command = "false"
args = []
`);
  const local = `
approvals_reviewer = "user"
[mcp_servers.graph.tools.list_projects]
approval_mode = "approve"
`;
  await writeFile(join(identity, "config.toml"), local);
  const env = { HOME: home, CODEX_HOME: identity, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", RUST_LOG: "off" };
  return { home, identity, env, local };
}

async function projected(home: string, identity: string, args: string[]) {
  const shared = await projectSharedCodexConfigForLaunch(CODEX_CONFIG, identity, args, home);
  const memory = await projectGlobalMemoryForLaunch(CODEX_CONFIG, identity, shared, {}, home);
  return codexSubcommandConfigArgs(memory.argv);
}

describe.skipIf(!native)("native Codex child config parsers", () => {
  test("app-server keeps shared transport, authoritative reviewer, memory and caller override precedence", async () => {
    const { home, identity, env, local } = await fixture();
    const args = await projected(home, identity, [
      "-c", 'model="root-model"', "app-server", "--stdio",
      "-c", "features.hooks=false", "--config", 'model="child-model"',
    ]);
    const proc = Bun.spawn([native!, ...args], { cwd: home, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function response(id: number): Promise<any> {
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === id) return message;
        } else {
          const part = await reader.read();
          if (part.done) throw new Error("Native app-server closed before its config response");
          buffer += decoder.decode(part.value, { stream: true });
        }
      }
    }
    try {
      proc.stdin.write(JSON.stringify({
        id: 1, method: "initialize",
        params: { clientInfo: { name: "ais-config-regression", version: "1" }, capabilities: {} },
      }) + "\n");
      expect((await response(1)).error).toBeUndefined();
      proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      proc.stdin.write(JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: false } }) + "\n");
      const result = await response(2);
      expect(result.error).toBeUndefined();
      const config = result.result.config;
      expect(config.model).toBe("child-model");
      expect(config.approvals_reviewer).toBe("auto_review");
      expect(config.approval_policy).toBe("on-request");
      expect(config.sandbox_mode).toBe("workspace-write");
      expect(config.features.hooks).toBe(false);
      expect(config.mcp_servers.graph.command).toBe("false");
      expect(config.mcp_servers.graph.tools.list_projects.approval_mode).toBe("approve");
      expect(config.developer_instructions).toContain("# AIS global memory");
      expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
    } finally {
      proc.stdin.end();
      while (!(await reader.read()).done) {
        // Drain the same reader through EOF; a consumed stream cannot be
        // wrapped in another Response under Bun.
      }
      reader.releaseLock();
      expect(await proc.exited).toBe(0);
      await stderr;
    }
  }, 10_000);

  test("exec with child -c reaches provider validation instead of failing MCP transport parsing", async () => {
    const { home, identity, env } = await fixture();
    const args = await projected(home, identity, [
      "exec", "--skip-git-repo-check", "-c", "features.hooks=false",
      "-c", 'model_provider="ais-regression-missing-provider"', "hello",
    ]);
    const proc = Bun.spawn([native!, ...args], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(exit).toBe(1);
    expect(stderr).toContain("Model provider `ais-regression-missing-provider` not found");
    expect(stderr).not.toContain("invalid transport");
    expect(stdout).toBe("");
  }, 10_000);
});
