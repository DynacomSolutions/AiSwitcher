import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncT3InstancesLive } from "../../src/t3/instances/live.ts";

let home: string;
let secrets: string;
let calls: { method: string; path: string; auth: string }[];
const SCOPE = "scope-token-value";
const list = { apps: [{ name: "t3-kimi-pool", provider: "kimi", state: "active", target: { kind: "pool" } }, { name: "t3-zai-pool", provider: "zai", state: "active", target: { kind: "pool" } }] };
const fetchStub = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname;
  calls.push({ method: String(init.method), path, auth: String((init.headers as Record<string, string>).authorization) });
  if (path === "/apps") return new Response(JSON.stringify(list), { status: 200 });
  if (path === "/apps/t3-kimi-pool/instance-token") return new Response(JSON.stringify({ app: "t3-kimi-pool", token: "aisg_fromgw" }), { status: 201 });
  return new Response(JSON.stringify({ error: "no such app" }), { status: 404 });
}) as unknown as typeof fetch;
const deps = () => ({ fetch: fetchStub, kubectl: (() => Promise.reject(new Error("no"))) as never, secretsPath: secrets, out: () => {}, now: () => 0 });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "t3-live-"));
  secrets = join(home, "secrets");
  calls = [];
  await writeFile(secrets, `AIS_GATEWAY_ADMIN_URL=https://admin.example\nAIS_GATEWAY_INSTANCES_TOKEN=${SCOPE}\nAIS_GATEWAY_PROXY_URL=https://gw.example/gateway\n`);
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await writeFile(join(home, ".t3", "userdata", "settings.json"), "{}\n");
});
afterEach(() => rm(home, { recursive: true, force: true }));

test("with the scoped token the sync reads the list and each app token from the gateway and writes token files", async () => {
  const tokenDir = join(home, "run");
  const items = await syncT3InstancesLive(deps(), { home, env: {}, tokenDir, flavour: "pod", binaryDir: "/opt/agents" });
  expect(calls.every((c) => c.auth === `Bearer ${SCOPE}`)).toBe(true);
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /apps", "POST /apps/t3-kimi-pool/instance-token", "POST /apps/t3-zai-pool/instance-token"]);
  expect(items.find((i) => i.id === "t3-kimi-pool-acp")?.status).toBe("created");
  expect(items.find((i) => i.id === "t3-zai-pool-acp")?.status).toBe("skipped");
  expect((await readFile(join(tokenDir, "t3-kimi-pool"), "utf8")).trim()).toBe("aisg_fromgw");
  expect((await stat(join(tokenDir, "t3-kimi-pool"))).mode & 0o777).toBe(0o600);
  await expect(stat(join(tokenDir, "t3-zai-pool"))).rejects.toThrow();
});

test("check writes no token file", async () => {
  const tokenDir = join(home, "run");
  await syncT3InstancesLive(deps(), { home, env: {}, tokenDir, check: true });
  await expect(stat(join(tokenDir, "t3-kimi-pool"))).rejects.toThrow();
});

test("the scoped token is preferred to the admin token, and the admin token alone still works without token reads", async () => {
  await writeFile(secrets, `AIS_GATEWAY_ADMIN_URL=https://admin.example\nAIS_GATEWAY_ADMIN_TOKEN=adm\nAIS_GATEWAY_PROXY_URL=https://gw.example/gateway\nAIS_GATEWAY_APP_T3_KIMI_POOL_TOKEN=aisg_local1\n`);
  await syncT3InstancesLive(deps(), { home, env: {} });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /apps"]);
  expect(calls[0]!.auth).toBe("Bearer adm");
});
