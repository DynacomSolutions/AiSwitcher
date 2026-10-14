import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwapCommand } from "../../src/cli/swap/dispatch.ts";
import { requirePool } from "../../src/identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../../src/identities/store.ts";

let root = "";
let registry = "";
let out: string[] = [];
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (user: string, iat: number) => `${b64({ alg: "none" })}.${b64({ user_id: user, iat, exp: iat + 900 })}.SYNTHETIC_FIXTURE`;
const T0 = 1_789_200_000;
const usage = (label: string, utilization: number) => ({ status: "live" as const, maxUtilization: utilization, windows: [{ label, utilization }], capturedAt: "x" });
const deps = () => ({ registryPath: registry, ledgerPath: join(root, "ledger.jsonl"), log: (l: string) => out.push(l), fetchUsage: async () => usage("5h", 12) });

const tools = {
  kimi: {
    file: join("credentials", "kimi-code.json"),
    text: (user: string) => JSON.stringify({ access_token: jwt(user, T0), refresh_token: `SYNTHETIC_FIXTURE-rt-${user}`, expires_at: T0 + 900 }),
    user: (text: string) => JSON.parse(text).access_token as string,
  },
  pi: {
    file: "auth.json",
    text: (user: string) => JSON.stringify({ "kimi-coding": { type: "oauth", access: jwt(user, T0), refresh: `SYNTHETIC_FIXTURE-rt-${user}`, expires: (T0 + 900) * 1000 } }),
    user: (text: string) => JSON.parse(text)["kimi-coding"].access as string,
  },
} as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-swap-kimi-pi-"));
  registry = join(root, "identities.json");
  out = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const tool of ["kimi", "pi"] as const) {
  describe(`ais swap ${tool}`, () => {
    const spec = tools[tool];
    const put = async (name: string, text: string) => { await mkdir(join(root, name, ...spec.file.split("/").slice(0, -1)), { recursive: true }); await writeFile(join(root, name, spec.file), text); };
    const swap = (positionals: string[], flags: Record<string, string | true> = {}) => runSwapCommand(tool, positionals, flags, deps());

    beforeEach(async () => {
      await put("a", spec.text("user-a"));
      await put("b", spec.text("user-b"));
      await put("loggedout", JSON.stringify({}));
      const id = (name: string) => ({ name, label: name, configDir: join(root, name) });
      await writeFile(registry, JSON.stringify({ version: 1, identities: [id("a"), id("b"), id("loggedout")] }));
    });

    test("pool create validates OAuth members, activates the first, and runs status/to/auto without a relaunch warning", async () => {
      await expect(swap(["pool", "create", "shared"], { accounts: "a,loggedout", "config-dir": join(root, "shared") })).rejects.toThrow(/loggedout.*no .* OAuth login/);
      await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool).toEqual({ accounts: ["a", "b"], active: "a" });
      expect(spec.user(await readFile(join(root, "shared", spec.file), "utf8"))).toBe(spec.user(spec.text("user-a")));

      out = [];
      await swap(["status"]);
      expect(out.join("\n")).toContain("5h 12%");
      out = [];
      await swap(["to", "b"]);
      expect(out[0]).toContain("shared: a -> b");
      expect(out.join("\n")).not.toContain("running session");
      expect(spec.user(await readFile(join(root, "shared", spec.file), "utf8"))).toBe(spec.user(spec.text("user-b")));
      await swap(["auto", "on"], { threshold: "90" });
      expect(requirePool(await loadIdentitiesFile(registry), undefined, tool).swapPool).toMatchObject({ active: "b", auto: true, thresholdPercent: 90 });
      await expect(swap(["usage"])).rejects.toThrow(/not available for/);
    });
  });
}
