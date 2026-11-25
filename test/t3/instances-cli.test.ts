import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runT3InstancesCommand } from "../../src/cli/gateway/t3-instances.ts";
import { createT3InstancesTicker } from "../../src/sync/t3-instances-ticker.ts";

let home: string;
let secrets: string;
const apps = { apps: [{ name: "t3-grok-pool", provider: "grok", state: "active", target: { kind: "pool" } }] };
const deps = (list: unknown, lines: string[]) => ({
  fetch: (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch,
  kubectl: (() => Promise.reject(new Error("no"))) as never,
  secretsPath: secrets,
  out: (l: string) => void lines.push(l),
  now: () => 0,
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "t3-inst-cli-"));
  secrets = join(home, "secrets");
  await writeFile(secrets, "AIS_GATEWAY_ADMIN_URL=https://admin.example\nAIS_GATEWAY_ADMIN_TOKEN=x\nAIS_GATEWAY_PROXY_URL=https://gw.example/gateway\nAIS_GATEWAY_APP_T3_GROK_POOL_TOKEN=aisg_tok\n");
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await writeFile(join(home, ".t3", "userdata", "settings.json"), "{}\n");
});
afterEach(() => rm(home, { recursive: true, force: true }));

test("sync reads the live app list and writes the instances; --check then passes", async () => {
  const lines: string[] = [];
  await runT3InstancesCommand(["sync"], {}, deps(apps, lines), { home, env: {} });
  expect(lines.join("\n")).toContain("t3-grok-pool created");
  expect(Object.keys(JSON.parse(await readFile(join(home, ".t3", "userdata", "settings.json"), "utf8")).providerInstances)).toContain("t3-grok-pool");
  await runT3InstancesCommand(["sync"], { check: true }, deps(apps, []), { home, env: {} });
});

test("--check fails when the settings differ from the app list", async () => {
  await expect(runT3InstancesCommand(["sync"], { check: true }, deps(apps, []), { home, env: {} })).rejects.toThrow(/differ/);
});

test("the ticker asks again each run and logs a change once", async () => {
  const log: string[] = [];
  let t = 0;
  let calls = 0;
  const tk = createT3InstancesTicker({ run: async () => (calls++, [{ id: "t3-grok-pool", status: "created" as const }]), now: () => t, log: (m) => void log.push(m), intervalMs: 10 });
  await tk.tick();
  await tk.idle();
  t = 20;
  await tk.tick();
  await tk.idle();
  expect(calls).toBe(2);
  expect(log).toHaveLength(1);
});
