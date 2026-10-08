import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { promptForIdentity, type PromptDeps } from "../src/identities/prompt.ts";
import { readLastIdentity, writeLastIdentity } from "../src/identities/last-identity.ts";
import type { IdentitiesFile, ToolConfig } from "../src/identities/types.ts";

type SelectOpts = {
  message: string;
  initialValue?: string;
  options: Array<{ value: string; label: string; hint?: string }>;
};

let dir: string;
let memoryPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ais-picker-"));
  memoryPath = join(dir, "state", "last-identity.json");
});
afterEach(() => {
  for (const fn of ["select", "intro", "outro"] as const) spyOn(clack, fn).mockRestore();
  spyOn(clack.log, "error").mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function registry(): IdentitiesFile {
  return {
    version: 1,
    identities: [
      { name: "solo", label: "Solo", configDir: "/example/solo" },
      { name: "acct-a", label: "Account A", configDir: "/example/acct-a" },
      { name: "acct-b", label: "Account B", configDir: "/example/acct-b" },
      { name: "acct-c", label: "Account C", configDir: "/example/acct-c" },
      {
        name: "shared-pool",
        label: "Shared Pool",
        configDir: "/example/shared-pool",
        swapPool: { accounts: ["acct-a", "acct-b", "acct-c"], active: "acct-a", disallowed: ["acct-c"] },
      },
    ],
  };
}

const cfg = { toolName: "claude" } as ToolConfig;

function harness(answers: string[]) {
  const calls: SelectOpts[] = [];
  const switched: Array<[string, string]> = [];
  const errors: string[] = [];
  spyOn(clack, "intro").mockImplementation(() => {});
  spyOn(clack, "outro").mockImplementation(() => {});
  spyOn(clack.log, "error").mockImplementation(((msg: string) => void errors.push(msg)) as never);
  spyOn(clack, "select").mockImplementation((async (opts: SelectOpts) => {
    calls.push(opts);
    return answers.shift();
  }) as never);
  const deps: PromptDeps = {
    switchMember: async (pool, member) => void switched.push([pool.name, member]),
    readLast: (tool) => readLastIdentity(tool, memoryPath),
    writeLast: (tool, name) => writeLastIdentity(tool, name, memoryPath),
  };
  return { calls, switched, errors, deps };
}

test("picker lists Claude Pools after identities and before create, pools not listed directly", async () => {
  const h = harness(["solo"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  const values = h.calls[0]!.options.map((o) => o.value);
  expect(values).toContain("acct-a");
  expect(values).not.toContain("shared-pool");
  const labels = h.calls[0]!.options.map((o) => o.label);
  expect(labels.slice(-2)).toEqual(["Claude Pools", "+ Create new identity"]);
});

test("Claude Pools lists every member with active and not-allowed markers", async () => {
  const h = harness(["__claude_pools__", "acct-b"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  const members = h.calls[1]!.options;
  expect(members.map((o) => o.value)).toEqual(["acct-a", "acct-b", "acct-c"]);
  expect(members.map((o) => o.label)).toEqual(["Account A", "Account B", "Account C"]);
  expect(members[0]!.hint).toBe("(active)");
  expect(members[1]!.hint).toBeUndefined();
  expect(members[2]!.hint).toBe("(not allowed)");
});

test("choosing a member switches manually and launches the pool", async () => {
  const h = harness(["__claude_pools__", "acct-b"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.switched).toEqual([["shared-pool", "acct-b"]]);
  expect(result.identity.name).toBe("shared-pool");
  expect(result.created).toBe(false);
  expect(await readLastIdentity("claude", memoryPath)).toBe("shared-pool");
});

test("a disallowed member is refused: no switch, error shown, back to the picker", async () => {
  const h = harness(["__claude_pools__", "acct-c", "solo"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.switched).toEqual([]);
  expect(h.errors.join("\n")).toContain("not allowed");
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2]!.message).toBe("Select an identity to use");
  expect(result.identity.name).toBe("solo");
});

test("the remembered identity is pre-selected and a pick is recorded", async () => {
  await writeLastIdentity("claude", "acct-b", memoryPath);
  await writeLastIdentity("codex", "other", memoryPath);
  const h = harness(["acct-a"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls[0]!.initialValue).toBe("acct-b");
  expect(await readLastIdentity("claude", memoryPath)).toBe("acct-a");
  expect(await readLastIdentity("codex", memoryPath)).toBe("other");
  expect(statSync(memoryPath).mode & 0o777).toBe(0o600);
});

test("a remembered pool pre-selects the Claude Pools entry", async () => {
  await writeLastIdentity("claude", "shared-pool", memoryPath);
  const h = harness(["solo"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls[0]!.initialValue).toBe("__claude_pools__");
});

test("a remembered identity that is gone or retired falls back to the first entry", async () => {
  const file = registry();
  file.identities[1]!.retired = true;
  for (const stale of ["acct-a", "vanished"]) {
    await writeLastIdentity("claude", stale, memoryPath);
    const h = harness(["solo"]);
    await promptForIdentity(file, cfg, 1000, h.deps);
    expect(h.calls[0]!.initialValue).toBe("solo");
    spyOn(clack, "select").mockRestore();
  }
});

test("a corrupt memory file is ignored and then replaced", async () => {
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(memoryPath, "{not json");
  const h = harness(["acct-b"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls[0]!.initialValue).toBe("solo");
  expect(result.identity.name).toBe("acct-b");
  expect(JSON.parse(readFileSync(memoryPath, "utf8"))).toEqual({ claude: "acct-b" });
});
