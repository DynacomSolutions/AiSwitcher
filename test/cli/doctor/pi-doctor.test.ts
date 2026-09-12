import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePiDoctor } from "../../../src/cli/doctor/pi-doctor.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG } from "../../../src/identities/tool-configs.ts";
import type { Identity } from "../../../src/identities/types.ts";

// Same temp-registry trick as the reconcile tests: real registry files under
// a temp root, the five tools' identitiesJsonPath repointed per test.
const tempDirs: string[] = [];
const savedPaths: Record<string, string> = {};

let dirs: Record<"claude" | "codex" | "grok" | "kimi" | "pi", string> = {} as never;

const ACME = "acme";

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-pi-doctor-"));
  tempDirs.push(root);
  dirs = {
    claude: join(root, "claude-identities", ACME),
    codex: join(root, "codex-identities", ACME),
    grok: join(root, "grok-identities", ACME),
    kimi: join(root, "kimi-identities", ACME),
    pi: join(root, "pi-identities", ACME),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["grok", GROK_CONFIG],
    ["kimi", KIMI_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    savedPaths[tool] = path.identitiesJsonPath;
    (path as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}-identities.json`);
    await writeFile(
      path.identitiesJsonPath,
      JSON.stringify({ version: 1, identities: [{ name: ACME, label: "Acme", configDir: dirs[tool] }] }),
    );
  }
});

afterEach(async () => {
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["grok", GROK_CONFIG],
    ["kimi", KIMI_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    if (savedPaths[tool]) (path as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths[tool];
  }
  const roots = tempDirs.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function acmePi(): Identity {
  return { name: ACME, label: "Acme", configDir: dirs.pi };
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

describe("probePiDoctor", () => {
  test("diverged copies report degraded with fingerprints and remediation", async () => {
    await json(join(dirs.claude, ".credentials.json"), {
      claudeAiOauth: { accessToken: "native-acc", refreshToken: "native-ref", expiresAt: 1_900_000_000_000 },
    });
    await json(join(dirs.pi, "auth.json"), {
      anthropic: { type: "oauth", access: "pi-access", refresh: "pi-refresh", expires: 1_700_000_000_000 },
    });
    const result = await probePiDoctor(acmePi());
    expect(result.status).toBe("degraded");
    expect(result.statusWord).toBe("forked");
    expect(result.detail).toContain("anthropic");
    expect(result.detail).toMatch(/[0-9a-f]{8}/);
    expect(result.detail).toContain("ais auth sync --tool=pi acme");
    expect(result.detail).toContain("launch pi");
    // Never a token value.
    expect(result.detail).not.toContain("native-ref");
    expect(result.detail).not.toContain("pi-refresh");
  });

  test("converged copies report in sync", async () => {
    await json(join(dirs.claude, ".credentials.json"), {
      claudeAiOauth: { accessToken: "native-acc", refreshToken: "shared-ref", expiresAt: 1_900_000_000_000 },
    });
    await json(join(dirs.pi, "auth.json"), {
      anthropic: { type: "oauth", access: "pi-access", refresh: "shared-ref", expires: 1_900_000_000_000 },
    });
    const result = await probePiDoctor(acmePi());
    expect(result.status).toBe("responsive");
    expect(result.statusWord).toBe("in sync");
    expect(result.detail).toContain("no diverged copies");
  });

  test("no counterpart registries at all is honest, not degraded", async () => {
    await json(join(dirs.pi, "auth.json"), {
      anthropic: { type: "oauth", access: "pi-access", refresh: "pi-refresh", expires: 1_700_000_000_000 },
    });
    await rm(CLAUDE_CONFIG.identitiesJsonPath);
    await rm(CODEX_CONFIG.identitiesJsonPath);
    await rm(GROK_CONFIG.identitiesJsonPath);
    await rm(KIMI_CONFIG.identitiesJsonPath);
    const result = await probePiDoctor(acmePi());
    expect(result.status).toBe("responsive");
    expect(result.detail).toContain("no native counterpart identities");
  });
});
