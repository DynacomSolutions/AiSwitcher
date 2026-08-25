import { describe, expect, test } from "bun:test";
import { addRemote, parseSyncConfig, removeRemote, syncConfigPath, validateRemoteHost } from "../../src/sync/config.ts";

describe("AIS sync config", () => {
  test("keeps the merge protocol separate from live version 1 wrappers", () => {
    expect(syncConfigPath({}, "/home/tester")).toBe("/home/tester/.ais/config/sync-v2.json");
  });

  test("accepts SSH config aliases and de-duplicates them in order", () => {
    expect(parseSyncConfig({ version: 2, remotes: ["remote1", "user@backup", "remote1"] })).toEqual({
      version: 2,
      remotes: ["remote1", "user@backup"],
    });
  });

  test("migrates the pre-merge version 1 config in memory", () => {
    expect(parseSyncConfig({ version: 1, remotes: ["remote1"] })).toEqual({
      version: 2,
      remotes: ["remote1"],
    });
  });

  test("rejects aliases that could become SSH/rsync options or remote-shell syntax", () => {
    for (const host of ["-oProxyCommand=x", "remote1:22", "hq 0", "remote1;touch-x", ""]) {
      expect(() => validateRemoteHost(host)).toThrow();
    }
  });

  test("add/remove are idempotent mutations", () => {
    const config = { version: 2 as const, remotes: ["remote1"] };
    expect(addRemote(config, "remote1")).toBe(false);
    expect(addRemote(config, "backup")).toBe(true);
    expect(removeRemote(config, "missing")).toBe(false);
    expect(removeRemote(config, "remote1")).toBe(true);
    expect(config.remotes).toEqual(["backup"]);
  });
});
