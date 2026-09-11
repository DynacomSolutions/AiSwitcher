import { describe, expect, test } from "bun:test";
import { pickSourceIdentity } from "../../../src/cli/auth/pi-sync.ts";

describe("pickSourceIdentity", () => {
  test("an explicit flag wins when the named identity exists", () => {
    const pick = pickSourceIdentity("identity-a", "identity-b", ["identity-b", "identity-a"], "claude", "claude");
    expect(pick).toEqual({ name: "identity-b", via: "--claude flag" });
  });

  test("a flag naming a missing identity is skipped, never guessed", () => {
    const pick = pickSourceIdentity("identity-a", "missing", ["identity-a"], "claude", "claude");
    expect("skip" in pick && pick.skip).toContain('no claude identity named "missing"');
  });

  test("the same-named identity beats the single-identity rule", () => {
    const pick = pickSourceIdentity("identity-a", undefined, ["identity-b", "identity-a"], "grok", "grok");
    expect(pick).toEqual({ name: "identity-a", via: "same-named identity" });
  });

  test("a registry with exactly one identity shares it", () => {
    const pick = pickSourceIdentity("identity-a", undefined, ["identity-b"], "zai", "zai");
    expect(pick).toEqual({ name: "identity-b", via: "only identity in the registry" });
  });

  test("an ambiguous registry is skipped with a pick-one note", () => {
    const pick = pickSourceIdentity("identity-c", undefined, ["identity-a", "identity-b"], "codex", "codex");
    expect("skip" in pick).toBe(true);
    if ("skip" in pick) {
      expect(pick.skip).toContain("identity-a, identity-b");
      expect(pick.skip).toContain("--codex=<name>");
    }
  });

  test("an empty registry is skipped honestly", () => {
    const pick = pickSourceIdentity("identity-a", undefined, [], "kimi", "kimi");
    expect("skip" in pick && pick.skip).toContain("(none)");
  });
});
