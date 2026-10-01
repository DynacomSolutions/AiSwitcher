import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSettingsArgs, detectGatedPlugins, gatePluginArgs } from "../../src/shared/plugin-gating.ts";

const ID = "vercel@claude-plugins-official";
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ais-gate-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(): string {
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "repo", "apps", "web"), { recursive: true });
  return join(root, "repo");
}

describe("detectGatedPlugins", () => {
  test("marker at cwd", () => {
    const r = repo();
    writeFileSync(join(r, "vercel.json"), "{}");
    expect(detectGatedPlugins(r)).toEqual([ID]);
  });
  test("marker in .vercel/project.json", () => {
    const r = repo();
    mkdirSync(join(r, ".vercel"));
    writeFileSync(join(r, ".vercel", "project.json"), "{}");
    expect(detectGatedPlugins(r)).toEqual([ID]);
  });
  test("marker at a parent below the git root", () => {
    const r = repo();
    writeFileSync(join(r, "vercel.ts"), "");
    expect(detectGatedPlugins(join(r, "apps", "web"))).toEqual([ID]);
  });
  test("absent", () => {
    expect(detectGatedPlugins(join(repo(), "apps", "web"))).toEqual([]);
  });
  test("marker beyond the git root is ignored", () => {
    writeFileSync(join(root, "vercel.json"), "{}");
    expect(detectGatedPlugins(join(repo(), "apps", "web"))).toEqual([]);
  });
});

describe("composeSettingsArgs", () => {
  const overlay = (v: string) => JSON.parse(v).enabledPlugins;
  test("appends an overlay when none supplied", () => {
    const out = composeSettingsArgs(["-p", "hi"], [ID]);
    expect(out.slice(0, 2)).toEqual(["-p", "hi"]);
    expect(out[2]).toBe("--settings");
    expect(overlay(out[3]!)).toEqual({ [ID]: true });
  });
  test("inserts before a -- terminator", () => {
    const out = composeSettingsArgs(["--", "prompt"], [ID]);
    expect(out[0]).toBe("--settings");
    expect(out.slice(2)).toEqual(["--", "prompt"]);
  });
  test("merges into user JSON settings", () => {
    const out = composeSettingsArgs(["--settings", '{"model":"x","enabledPlugins":{"a@b":true}}'], [ID]);
    expect(out.filter((a) => a === "--settings")).toHaveLength(1);
    const merged = JSON.parse(out[1]!);
    expect(merged.model).toBe("x");
    expect(merged.enabledPlugins).toEqual({ "a@b": true, [ID]: true });
  });
  test("merges into --settings=file form", () => {
    const f = join(root, "s.json");
    writeFileSync(f, '{"model":"y"}');
    const out = composeSettingsArgs([`--settings=${f}`], [ID]);
    expect(out).toHaveLength(1);
    const merged = JSON.parse(out[0]!.slice("--settings=".length));
    expect(merged.model).toBe("y");
    expect(merged.enabledPlugins[ID]).toBe(true);
  });
  test("user explicit false wins", () => {
    const out = composeSettingsArgs(["--settings", `{"enabledPlugins":{"${ID}":false}}`], [ID]);
    expect(overlay(out[1]!)[ID]).toBe(false);
  });
  test("unreadable user settings leave argv untouched", () => {
    const argv = ["--settings", join(root, "missing.json")];
    expect(composeSettingsArgs(argv, [ID])).toEqual(argv);
  });
  test("no plugins is a no-op", () => {
    expect(composeSettingsArgs(["a"], [])).toEqual(["a"]);
  });
});

describe("gatePluginArgs", () => {
  test("only claude is gated", () => {
    const r = repo();
    writeFileSync(join(r, "vercel.json"), "{}");
    expect(gatePluginArgs("codex", ["x"], r)).toEqual(["x"]);
    expect(gatePluginArgs("claude", ["x"], r)).toHaveLength(3);
  });
  test("non-vercel project passes argv through", () => {
    expect(gatePluginArgs("claude", ["x"], repo())).toEqual(["x"]);
  });
});
