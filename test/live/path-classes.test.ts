import { describe, expect, test } from "bun:test";
import { classify } from "../../src/live/path-classes.ts";

describe("live path classes", () => {
  test("classifies only known tool auth stores, identity registries, and session trees", () => {
    expect(classify(".claude/.credentials.json")).toBe("auth");
    expect(classify(".codex/identities/work/auth.json")).toBe("auth");
    expect(classify(".kimi-code/identities/work/credentials/kimi-code.json")).toBe("auth");
    expect(classify(".opencode/identities/work/data/opencode/auth.json")).toBe("auth");
    expect(classify(".claude/identities.json")).toBe("config:identity");
    expect(classify(".codex/identities/work/config.toml")).toBe("config:settings");
    expect(classify(".claude/projects/sample/session.jsonl")).toBe("logs");
    expect(classify(".ais/config/sync-v2.json")).toBe("config:settings");
    expect(classify(".ais/hooks/review.sh")).toBe("config:settings");
    expect(classify(".ais/logs/exchange.jsonl")).toBe("logs");
    expect(classify(".ais/memory/GLOBAL.md")).toBe("ignore");
  });

  test("rejects unrelated auth-looking paths and unsafe path syntax", () => {
    for (const path of ["Downloads/auth.json", "project/.credentials.json", "../.codex/auth.json", ".ssh/../auth.json", "/.codex/auth.json", ".codex\\auth.json"]) {
      expect(classify(path)).toBe("ignore");
    }
  });

  test("classifies every tool identity registry as portable identity configuration", () => {
    for (const root of [".claude", ".codex", ".grok", ".kimi-code", ".pi", ".opencode", ".zai", ".ali"]) {
      expect(classify(`${root}/identities.json`)).toBe("config:identity");
    }
  });
});
