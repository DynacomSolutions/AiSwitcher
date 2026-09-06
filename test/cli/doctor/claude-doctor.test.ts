import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudeDoctor } from "../../../src/cli/doctor/claude-doctor.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function identity(configDir: string): Identity {
  return { name: "personal", label: "Personal", configDir };
}

/** The wipe signature, verbatim from the live machine 2026-09-07: both
 * token fields empty, expiresAt 0, metadata preserved. */
const WIPED_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    refreshTokenExpiresAt: 1790794435676,
    scopes: ["user:file_upload", "user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
};

describe("probeClaudeDoctor credential-wipe detection", () => {
  test("a wiped credentials file short-circuits the live probe with the rotation-race diagnosis", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-claude-doctor-test-"));
    tempDirs.push(dir);
    await writeFile(join(dir, ".credentials.json"), JSON.stringify(WIPED_CREDENTIALS));

    const startedAt = Date.now();
    const result = await probeClaudeDoctor(identity(dir));

    // "unavailable": the live turn is never attempted (and this test would
    // otherwise spawn the real binary for up to 20s, so a fast return also
    // proves the short-circuit ran before any spawn).
    expect(result.toolName).toBe("claude");
    expect(result.identity.name).toBe("personal");
    expect(result.status).toBe("unavailable");
    expect(result.elapsedMs).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.detail).toContain("credentials invalidated by a failed token refresh");
    expect(result.detail).toContain("rotating refresh token");
    expect(result.detail).toContain("claude auth login");
    expect(result.detail).toContain("never run a second AIS web server/pod against the same home");
  });
});
