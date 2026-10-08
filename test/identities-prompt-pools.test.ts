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
  options: Array<{ value: string; label: string; hint?: string; disabled?: boolean }>;
};

let dir: string;
let memoryPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ais-picker-"));
  memoryPath = join(dir, "state", "last-identity.json");
});
afterEach(() => {
  for (const fn of ["select", "intro", "outro", "isCancel"] as const) spyOn(clack, fn).mockRestore();
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

const CANCEL = Symbol("cancel");

function harness(answers: unknown[]) {
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
  spyOn(clack, "isCancel").mockImplementation(((v: unknown) => v === CANCEL) as never);
  const deps: PromptDeps = {
    switchMember: async (pool, member) => void switched.push([pool.name, member]),
    readLast: (tool) => readLastIdentity(tool, memoryPath),
    writeLast: (tool, name) => writeLastIdentity(tool, name, memoryPath),
  };
  return { calls, switched, errors, deps };
}

const plainText = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const labels = (o: SelectOpts) => o.options.map((x) => plainText(x.label));

test("prompt 1 is a chooser with Identity and Pool, then prompt 2 lists identities", async () => {
  const h = harness(["identity", "solo"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls.map((c) => c.message)).toEqual(["Select an identity or pool", "Select an identity"]);
  expect(labels(h.calls[0]!)).toEqual(["Identity", "Pool"]);
  expect(labels(h.calls[1]!)).toEqual([
    "Solo",
    "Account A [pool: shared-pool]",
    "Account B [pool: shared-pool]",
    "Account C [pool: shared-pool (not allowed)]",
    "+ Create new identity",
  ]);
  expect(result.identity.name).toBe("solo");
});

test("no disabled rows, no Claude Pools row, no pool row on the identity screen", async () => {
  const h = harness(["identity", "solo"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  for (const c of h.calls) {
    expect(c.options.some((o) => o.disabled)).toBe(false);
    expect(labels(c)).not.toContain("Claude Pools");
  }
  expect(h.calls[1]!.options.map((o) => o.value)).not.toContain("shared-pool");
});

test("pool list: one row per pool, hint has member count and active account, no member rows", async () => {
  const h = harness(["pool", "shared-pool"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls[1]!.message).toBe("Select a pool");
  expect(labels(h.calls[1]!)).toEqual(["Shared Pool"]);
  expect(h.calls[1]!.options[0]!.value).toBe("shared-pool");
  expect(h.calls[1]!.options[0]!.hint).toBe("3 accounts, active: Account A");
  expect(h.switched).toEqual([]);
  expect(result.identity.name).toBe("shared-pool");
  expect(result.created).toBe(false);
  expect(await readLastIdentity("claude", memoryPath)).toBe("shared-pool");
});

test("no pools: no chooser, behaves as before", async () => {
  const file = registry();
  file.identities.pop();
  const h = harness(["solo"]);
  await promptForIdentity(file, cfg, 1000, h.deps);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.message).toBe("Select an identity");
  expect(labels(h.calls[0]!)).toEqual(["Solo", "Account A", "Account B", "Account C", "+ Create new identity"]);
});

test("esc on prompt 2 returns to prompt 1; esc on prompt 1 cancels", async () => {
  const h = harness(["identity", CANCEL, "pool", CANCEL, "identity", "acct-b"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls.map((c) => c.message)).toEqual([
    "Select an identity or pool",
    "Select an identity",
    "Select an identity or pool",
    "Select a pool",
    "Select an identity or pool",
    "Select an identity",
  ]);
  expect(result.identity.name).toBe("acct-b");

  spyOn(clack, "select").mockRestore();
  const h2 = harness([CANCEL]);
  await expect(promptForIdentity(registry(), cfg, 1000, h2.deps)).rejects.toThrow();
});

test("esc on the only prompt (no chooser) cancels", async () => {
  const file = registry();
  file.identities.pop();
  const h = harness([CANCEL]);
  await expect(promptForIdentity(file, cfg, 1000, h.deps)).rejects.toThrow();
  expect(h.calls).toHaveLength(1);
});

test("remembered identity pre-selects kind Identity and the entry; a pick is recorded", async () => {
  await writeLastIdentity("claude", "acct-b", memoryPath);
  await writeLastIdentity("codex", "other", memoryPath);
  const h = harness(["identity", "acct-a"]);
  await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls[0]!.initialValue).toBe("identity");
  expect(h.calls[1]!.initialValue).toBe("acct-b");
  expect(await readLastIdentity("claude", memoryPath)).toBe("acct-a");
  expect(await readLastIdentity("codex", memoryPath)).toBe("other");
  expect(statSync(memoryPath).mode & 0o777).toBe(0o600);
});

test("remembered pool pre-selects kind Pool and that pool", async () => {
  await writeLastIdentity("claude", "other-pool", memoryPath);
  const file = registry();
  file.identities.push({
    name: "other-pool",
    label: "Other Pool",
    configDir: "/example/other-pool",
    swapPool: { accounts: ["acct-a"], active: "acct-a" },
  });
  const h = harness(["pool", "other-pool"]);
  const result = await promptForIdentity(file, cfg, 1000, h.deps);
  expect(h.calls[0]!.initialValue).toBe("pool");
  expect(h.calls[1]!.initialValue).toBe("other-pool");
  expect(labels(h.calls[1]!)).toEqual(["Shared Pool", "Other Pool"]);
  expect(result.identity.name).toBe("other-pool");
});

test("a remembered identity that is gone or retired falls back to Identity and the first entry", async () => {
  const file = registry();
  file.identities[1]!.retired = true;
  for (const stale of ["acct-a", "vanished"]) {
    await writeLastIdentity("claude", stale, memoryPath);
    const h = harness(["identity", "solo"]);
    await promptForIdentity(file, cfg, 1000, h.deps);
    expect(h.calls[0]!.initialValue).toBe("identity");
    expect(h.calls[1]!.initialValue).toBe("solo");
    spyOn(clack, "select").mockRestore();
  }
});

test("a corrupt memory file is ignored and then replaced", async () => {
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(memoryPath, "{not json");
  const h = harness(["identity", "acct-b"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps);
  expect(h.calls[1]!.initialValue).toBe("solo");
  expect(result.identity.name).toBe("acct-b");
  expect(JSON.parse(readFileSync(memoryPath, "utf8"))).toEqual({ claude: "acct-b" });
});

test("only=pool opens just the pool list, no chooser; esc cancels", async () => {
  const h = harness(["shared-pool"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps, "pool");
  expect(h.calls.map((c) => c.message)).toEqual(["Select a pool"]);
  expect(result.identity.name).toBe("shared-pool");

  spyOn(clack, "select").mockRestore();
  const h2 = harness([CANCEL]);
  await expect(promptForIdentity(registry(), cfg, 1000, h2.deps, "pool")).rejects.toThrow();
  expect(h2.calls).toHaveLength(1);
});

test("only=identity opens just the identity list, no chooser; esc cancels", async () => {
  const h = harness(["acct-a"]);
  const result = await promptForIdentity(registry(), cfg, 1000, h.deps, "identity");
  expect(h.calls.map((c) => c.message)).toEqual(["Select an identity"]);
  expect(result.identity.name).toBe("acct-a");

  spyOn(clack, "select").mockRestore();
  const h2 = harness([CANCEL]);
  await expect(promptForIdentity(registry(), cfg, 1000, h2.deps, "identity")).rejects.toThrow();
  expect(h2.calls).toHaveLength(1);
});
