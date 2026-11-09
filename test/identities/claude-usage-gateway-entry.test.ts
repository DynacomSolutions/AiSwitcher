import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMemberUsage } from "../../src/identities/claude-usage-api.ts";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-usage-gw-entry-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("a folder routed through the gateway never sends the app token to the usage endpoint", async () => {
  const dir = join(root, "member");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".credentials.json"), gatewayEntryText("aisg_SYNTHETIC_FIXTURE_usage"));
  const registry = join(root, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "member", label: "member", configDir: dir }] }));
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}", { status: 401 });
  }) as unknown as typeof fetch;
  const usage = await fetchMemberUsage({ name: "member", label: "member", configDir: dir }, { fetchImpl, claudeRegistryPath: registry, cacheDir: join(root, "cache") });
  expect(usage.status).toBe("unavailable");
  expect(usage.error).toContain("gateway");
  expect(calls).toBe(0);
});
