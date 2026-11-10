import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudeDoctor } from "../../../src/cli/doctor/claude-doctor.ts";

const root = await mkdtemp(join(tmpdir(), "ais-claude-doctor-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("a folder whose proxy would catch its loopback base URL is degraded, with no turn attempted", async () => {
  const configDir = await mkdtemp(join(root, "swap-"));
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:47140/claude", HTTPS_PROXY: "http://proxy.example.test:47132" } }));
  const r = await probeClaudeDoctor({ name: "swap", label: "swap", configDir });
  expect(r.status).toBe("degraded");
  expect(r.statusWord).toBe("proxy misconfigured");
  expect(r.detail).toContain("NO_PROXY=127.0.0.1,localhost,::1");
  expect(r.elapsedMs).toBeUndefined();
});
