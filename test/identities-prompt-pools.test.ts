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

const GO = "__claude_pools__";
const memberValue = (pool: string, member: string) => `${pool}\u0000${member}`;

test("Identities screen lists only normal identities, create, and one Go to Claude Pools row", async () => {
  const h = harness(["solo"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.message).toBe("Identities");
  const values = h.calls[0]!.options.map((o) => o.value);
  expect(values).not.toContain("shared-pool");
  expect(h.calls[0]!.options.map((o) => o.label)).toEqual([
    "Solo",
    "Account A",
    "Account B",
    "Account C",
    "+ Create new identity",
    "Go to Claude Pools >",
  ]);
});

test("no pools: no Go to Claude Pools row", async () => {
  const file = registry();
  file.identities.pop();
  const h = harness(["solo"]);
  await promptForIdentity(file, cfg, 1000, h.deps);
  expect(h.calls[0]!.options.map((o) => o.value)).not.toContain(GO);
});

test("Claude Pools is a separate prompt listing every member with active and not-allowed markers", async () => {
  const h = harness([GO, memberValue("shared-pool", "acct-b")]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]!.message).toBe("Claude Pools");
  const members = h.calls[1]!.options;
  expect(members.map((o) => o.value)).toEqual(
    ["acct-a", "acct-b", "acct-c"].map((m) => memberValue("shared-pool", m)),
  );
  expect(members.map((o) => o.label)).toEqual(["Account A", "Account B", "Account C"]);
  expect(members[0]!.hint).toBe("(active)");
  expect(members[1]!.hint).toBeUndefined();
  expect(members[2]!.hint).toBe("(not allowed)");
  expect(h.calls[1]!.initialValue).toBe(memberValue("shared-pool", "acct-a"));
});

test("several pools: members are distinguishable by pool name in the hint", async () => {
  const file = registry();
  file.identities.push({
    name: "other-pool",
    label: "Other Pool",
    configDir: "/example/other-pool",
    swapPool: { accounts: ["acct-a"], active: "acct-a" },
  });
  const h = harness([GO, memberValue("other-pool", "acct-a")]);
  const result = await promptForIdentity(file, cfg, 1000, h.deps);
  const hints = h.calls[1]!.options.map((o) => o.hint);
  expect(hints).toEqual([
    "Shared Pool (active)",
    "Shared Pool",
    "Shared Pool (not allowed)",
    "Other Pool (active)",
  ]);
  expect(h.switched).toEqual([["other-pool", "acct-a"]]);
  expect(result.identity.name).toBe("other-pool");
});

test("choosing a member switches manually and launches the pool", async () => {
  const h = harness([GO, memberValue("shared-pool", "acct-b")]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.switched).toEqual([["shared-pool", "acct-b"]]);
  expect(result.identity.name).toBe("shared-pool");
  expect(result.created).toBe(false);
  expect(await readLastIdentity("claude", memoryPath)).toBe("shared-pool");
});

test("a disallowed member is refused: no switch, error shown, back to the picker", async () => {
  const h = harness([GO, memberValue("shared-pool", "acct-c"), "solo"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.switched).toEqual([]);
  expect(h.errors.join("\n")).toContain("not allowed");
  expect(h.calls).toHaveLength(3);
  expect(h.calls[2]!.message).toBe("Identities");
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

test("a remembered pool pre-selects the Go row, then its active member on the Claude Pools screen", async () => {
  await writeLastIdentity("claude", "shared-pool", memoryPath);
  const file = registry();
  file.identities[4]!.swapPool!.active = "acct-b";
  const h = harness([GO, memberValue("shared-pool", "acct-b")]);
  await promptForIdentity(file, cfg, 1000, h.deps);
  expect(h.calls[0]!.initialValue).toBe(GO);
  expect(h.calls[1]!.initialValue).toBe(memberValue("shared-pool", "acct-b"));
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
