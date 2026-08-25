import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { chromeMcpConfigFor, ensureChromeMcpRunning, loadChromeMcpIdentities } from "../src/identities/chrome-mcp.ts";

describe("Chrome MCP identity config", () => {
  test("has no source-controlled example identities", () => {
    expect(loadChromeMcpIdentities(join(import.meta.dir, "does-not-exist.json"))).toEqual({});
  });

  test("resolves only identities supplied by machine-local config", () => {
    const identities = { "identity-a": { port: 12_345, profileDir: "Default" } };
    expect(chromeMcpConfigFor("identity-a", identities)).toEqual({ port: 12_345, profileDir: "Default" });
    expect(chromeMcpConfigFor("identity-b", identities)).toBeUndefined();
  });

  test("excludes shared (non-identity) browsers, which are not identities", () => {
    expect(chromeMcpConfigFor("shared-browser")).toBeUndefined();
  });

  test("unknown identity resolves to undefined rather than throwing", () => {
    expect(chromeMcpConfigFor("no-such-identity")).toBeUndefined();
  });
});

describe("ensureChromeMcpRunning", () => {
  test("returns undefined for an unknown identity without spawning anything", async () => {
    // Guards the early return: if this ever started spawning for an unknown
    // identity it would shell out with an empty session name.
    expect(await ensureChromeMcpRunning("no-such-identity")).toBeUndefined();
  });

  test("does not resolve a shared (non-identity) browser as an identity", async () => {
    expect(await ensureChromeMcpRunning("shared-browser")).toBeUndefined();
  });
});
