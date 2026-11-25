import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwapCommand } from "../../src/cli/swap/dispatch.ts";
import { adapterFor } from "../../src/identities/pool/registry.ts";
import { appPoolMemberNames } from "../../src/gateway/serve.ts";
import { collectLimitTargets } from "../../src/cli/limits/collect.ts";
import { UnknownPoolError } from "../../src/identities/errors.ts";
import { resolveIdentity } from "../../src/identities/resolve.ts";
import { GROK_CONFIG } from "../../src/identities/tool-configs.ts";
import { deleteIdentity } from "../../src/cli/identities/actions.ts";
import { requirePool } from "../../src/identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../../src/identities/store.ts";

let root = "";
let registry = "";
let out: string[] = [];
const deps = () => ({ registryPath: registry, ledgerPath: join(root, "ledger.jsonl"), log: (l: string) => out.push(l) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-swap-record-"));
  registry = join(root, "identities.json");
  out = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const tool of ["grok", "opencode", "zai"] as const) {
  describe(`ais swap ${tool} (record only)`, () => {
    const swap = (positionals: string[], flags: Record<string, string | true> = {}) => runSwapCommand(tool, positionals, flags, deps());
    beforeEach(async () => {
      const id = (name: string) => ({ name, label: name, configDir: join(root, name) });
      await writeFile(registry, JSON.stringify({ version: 1, identities: [id("a"), id("b"), id("c")] }));
    });

    test("is not a generic launch adapter", () => {
      expect(adapterFor(tool)).toBeUndefined();
    });

    test("pool create records members and active, to switches the record, allow/disallow narrow gateway members", async () => {
      await expect(swap(["pool", "create", "shared"], { accounts: "a,nobody", "config-dir": join(root, "shared") })).rejects.toThrow(/nobody/);
      await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool).toEqual({ accounts: ["a", "b"], active: "a" });
      expect(await readdir(join(root, "shared"))).toEqual([]);

      out = [];
      await swap(["to", "b"]);
      expect(out[0]).toContain("shared: a -> b");
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool.active).toBe("b");

      await swap(["disallow", "a"]);
      const file = await loadIdentitiesFile(registry);
      expect(requirePool(file, undefined, tool).swapPool.disallowed).toEqual(["a"]);
      expect(appPoolMemberNames(file)).toEqual(["b"]);
      out = [];
      await swap(["status"], { "no-usage": true });
      expect(out.join("\n")).toContain("shared");
    });
  
    test("a one-member pool routes every gateway request to that member; active never points to a disallowed or retired one", async () => {
      await swap(["pool", "create", "solo"], { accounts: "a", "config-dir": join(root, "solo") });
      let file = await loadIdentitiesFile(registry);
      expect(requirePool(file, undefined, tool).swapPool).toEqual({ accounts: ["a"], active: "a" });
      expect(appPoolMemberNames(file)).toEqual(["a"]);
      await expect(swap(["to", "a"], { force: true })).resolves.toBeUndefined();
      await swap(["disallow", "a"]);
      file = await loadIdentitiesFile(registry);
      expect(requirePool(file, undefined, tool).swapPool.active).toBeUndefined();
      expect(appPoolMemberNames(file)).toEqual([]);
      await expect(swap(["to", "a"], { force: true })).rejects.toThrow(/not allowed/);
    });

    test("disallow skips a retired or missing member when it moves active; clears active when none is left", async () => {
      await writeFile(registry, JSON.stringify({ version: 1, identities: [
        { name: "a", label: "a", configDir: join(root, "a") },
        { name: "b", label: "b", configDir: join(root, "b"), retired: true },
        { name: "c", label: "c", configDir: join(root, "c") },
      ] }));
      await swap(["pool", "create", "tri"], { accounts: "a,c", "config-dir": join(root, "tri") });
      const file = await loadIdentitiesFile(registry);
      file.identities.find((i) => i.name === "tri")!.swapPool!.accounts = ["a", "b", "ghost", "c"];
      await writeFile(registry, JSON.stringify(file));
      await swap(["disallow", "a"]);
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool.active).toBe("c");
      out = [];
      await swap(["disallow", "c"]);
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool.active).toBeUndefined();
      expect(out.join("\n")).toMatch(/no allowed member/);
    });

    test("deleting the pool record (the documented undo) gives the gateway every login again", async () => {
      await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
      const file = await loadIdentitiesFile(registry);
      expect(appPoolMemberNames(file)).toEqual(["a", "b"]);
      deleteIdentity(file, "shared");
      expect(appPoolMemberNames(file)).toEqual(["a", "b", "c"]);
    });

    test("auto on is refused for a record-only pool", async () => {
      await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
      await expect(swap(["auto", "on"])).rejects.toThrow(/record-only/);
    });

    test("a record pool is skipped by limits targets and refused by --pool", async () => {
      await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
      const cfg = { ...GROK_CONFIG, toolName: tool, identitiesJsonPath: registry };
      expect((await collectLimitTargets(undefined, {}, [cfg])).map((t) => t.identity.name)).toEqual(["a", "b", "c"]);
      await expect(resolveIdentity(cfg, { explicitPoolFlag: "shared", cwd: root, env: {} } as never)).rejects.toBeInstanceOf(UnknownPoolError);
    });

    test("disallowing the active member moves active to the first allowed member", async () => {
      await swap(["pool", "create", "pair"], { accounts: "a,b", "config-dir": join(root, "pair") });
      await swap(["disallow", "a"]);
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool.active).toBe("b");
    });
  });
}

test("claude, codex, kimi and pi still need two accounts", async () => {
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "a", label: "a", configDir: join(root, "a") }] }));
  for (const tool of ["claude", "codex", "kimi", "pi"]) {
    await expect(runSwapCommand(tool, ["pool", "create", "solo"], { accounts: "a" }, deps())).rejects.toThrow(/at least two accounts/);
  }
});
