import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import { createApp } from "../../src/server/app.ts";
import { authStatus } from "../../src/server/auth.ts";
import {
  createIdentityInRegistry,
  listRegistries,
  retireIdentityInRegistry,
  unretireIdentityInRegistry,
} from "../../src/server/registries.ts";
import { HttpError } from "../../src/server/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigs(): Promise<{ configs: ToolConfig[]; configDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "ais-retire-api-"));
  tempDirs.push(home);
  const registryPath = join(home, "identities.json");
  return {
    configDir: join(home, "cfg"),
    configs: [
      {
        toolName: "claude",
        realBinaryName: "claude",
        envVarName: "CLAUDE_CONFIG_DIR",
        identitiesJsonPath: registryPath,
        identitiesRootDir: join(home, "identities"),
        globalMemoryProjection: "claude-append-file",
      },
    ],
  };
}

const NOW = new Date("2026-10-08T12:00:00.000Z");

describe("retire / unretire through the registry API", () => {
  test("retire marks the DTO, purges credentials via the injected purger, unretire restores", async () => {
    const { configs, configDir } = await makeConfigs();
    await createIdentityInRegistry("claude", { name: "testa", label: "Test A", configDir }, configs);
    const purged: string[] = [];

    const retired = await retireIdentityInRegistry("claude", "testa", configs, {
      now: () => NOW,
      purge: async ({ toolName, identity }) => {
        purged.push(`${toolName}/${identity.name}`);
        return { removed: ["synthetic/.credentials.json"], warnings: [] };
      },
    });
    expect(purged).toEqual(["claude/testa"]);
    expect(retired.identities[0]).toMatchObject({ name: "testa", retired: true, retiredAt: NOW.toISOString() });
    expect(retired.purge.removed).toEqual(["synthetic/.credentials.json"]);
    expect((await listRegistries(configs)).registries[0]!.identities[0]!.retired).toBe(true);

    const restored = await unretireIdentityInRegistry("claude", "testa", configs, { now: () => NOW });
    expect(restored.identities[0]!.retired).toBeUndefined();
    expect(restored.identities[0]!.retiredAt).toBeUndefined();
  });

  test("unknown tool or identity is a 404; unretiring an active identity is a 409", async () => {
    const { configs, configDir } = await makeConfigs();
    await createIdentityInRegistry("claude", { name: "testa", label: "Test A", configDir }, configs);
    const noPurge = { purge: async () => ({ removed: [], warnings: [] }) };

    const statusOf = async (run: () => Promise<unknown>): Promise<number | undefined> => {
      try {
        await run();
      } catch (err) {
        return err instanceof HttpError ? err.status : undefined;
      }
      return undefined;
    };
    expect(await statusOf(() => retireIdentityInRegistry("nope", "testa", configs, noPurge))).toBe(404);
    expect(await statusOf(() => retireIdentityInRegistry("claude", "missing", configs, noPurge))).toBe(404);
    expect(await statusOf(() => unretireIdentityInRegistry("claude", "missing", configs))).toBe(404);
    expect(await statusOf(() => unretireIdentityInRegistry("claude", "testa", configs))).toBe(409);
  });

  test("auth status reports a retired identity without probing", async () => {
    const { configs, configDir } = await makeConfigs();
    await createIdentityInRegistry("claude", { name: "testa", label: "Test A", configDir }, configs);
    await retireIdentityInRegistry("claude", "testa", configs, { purge: async () => ({ removed: [], warnings: [] }) });
    const dto = await authStatus(configs);
    expect(dto.entries).toHaveLength(1);
    expect(dto.entries[0]).toMatchObject({ identity: "testa", state: "retired", kind: "none", fixable: [] });
  });

  test("routes require the CSRF header and 404 an unknown tool", async () => {
    const app = createApp({ token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1" });
    const headers = { Host: "127.0.0.1:47129" };
    const noCsrf = await app.request("/api/identities/claude/testa/retire", { method: "POST", headers });
    expect(noCsrf.status).toBe(403);
    const noCsrfUn = await app.request("/api/identities/claude/testa/unretire", { method: "POST", headers });
    expect(noCsrfUn.status).toBe(403);
    const unknown = await app.request("/api/identities/not-a-tool/testa/retire", {
      method: "POST",
      headers: { ...headers, "X-AIS-Console": "1" },
    });
    expect(unknown.status).toBe(404);
  });
});
