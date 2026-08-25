import { describe, expect, test } from "bun:test";
import { codexPlatformArgs } from "../../src/shared/codex-platform-config.ts";

const args = ["exec", "hello"];
const macNodeReplConfig = `
[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/node_repl"
startup_timeout_sec = 120
`;

describe("codexPlatformArgs", () => {
  test("disables Codex.app node_repl when its synced macOS command is absent", () => {
    expect(codexPlatformArgs("/profile", args, {
      platform: "linux",
      readConfig: () => macNodeReplConfig,
      commandExists: () => false,
    })).toEqual(["-c", "mcp_servers.node_repl.enabled=false", ...args]);
  });

  test("preserves node_repl on macOS", () => {
    expect(codexPlatformArgs("/profile", args, {
      platform: "darwin",
      readConfig: () => macNodeReplConfig,
      commandExists: () => false,
    })).toBe(args);
  });

  test("does not disable a command that exists on this host", () => {
    expect(codexPlatformArgs("/profile", args, {
      platform: "linux",
      readConfig: () => macNodeReplConfig,
      commandExists: () => true,
    })).toBe(args);
  });

  test("does not hide unrelated missing MCP commands", () => {
    expect(codexPlatformArgs("/profile", args, {
      platform: "linux",
      readConfig: () => `
[mcp_servers.node_repl]
command = "/home/thomas/.local/bin/node_repl"
`,
      commandExists: () => false,
    })).toBe(args);
  });

  test("accepts a quoted TOML table name", () => {
    expect(codexPlatformArgs("/profile", [], {
      platform: "linux",
      readConfig: () => macNodeReplConfig.replace(".node_repl]", '."node_repl"]'),
      commandExists: () => false,
    })).toEqual(["-c", "mcp_servers.node_repl.enabled=false"]);
  });

  test("leaves args alone when config cannot be read", () => {
    expect(codexPlatformArgs("/profile", args, {
      platform: "linux",
      readConfig: () => { throw new Error("missing"); },
    })).toBe(args);
  });
});
