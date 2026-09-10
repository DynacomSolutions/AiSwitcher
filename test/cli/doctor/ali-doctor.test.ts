import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAliDoctor } from "../../../src/cli/doctor/ali-doctor.ts";
import { formatDoctorReport } from "../../../src/cli/doctor/report.ts";
import type { DoctorResult } from "../../../src/cli/doctor/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function identity(name = "personal"): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

async function withRefreshState(home: string, entry: Record<string, unknown> | null): Promise<string> {
  tempDirs.push(home);
  if (entry !== null) {
    await mkdir(join(home, ".ais", "web"), { recursive: true });
    await writeFile(
      join(home, ".ais", "web", "auth-refresh-state.json"),
      JSON.stringify({ entries: [entry] }),
    );
  }
  return home;
}

const FAILED_ENTRY = {
  tool: "ali",
  identity: "personal",
  lastAttemptAt: "2026-09-10T01:38:14.927Z",
  lastSuccessAt: "2026-09-05T10:30:56.178Z",
  lastError: "the auth browser for \"personal\" is not signed in to the Alibaba console",
  consecutiveFailures: 41,
};

describe("probeAliDoctor", () => {
  test("no state file at all is healthy, not degraded", async () => {
    const home = await withRefreshState(await mkdtemp(join(tmpdir(), "ais-doctor-ali-")), null);
    const result = await probeAliDoctor(identity(), home);
    expect(result.status).toBe("responsive");
    expect(result.detail).toContain("healthy");
  });

  test("a failed last attempt reports degraded with the consecutive count and error", async () => {
    const home = await withRefreshState(await mkdtemp(join(tmpdir(), "ais-doctor-ali-")), FAILED_ENTRY);
    const result = await probeAliDoctor(identity(), home);
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("41 consecutive");
    expect(result.detail).toContain("escalated");
    expect(result.detail).toContain("2026-09-10T01:38:14.927Z");
    expect(result.detail).toContain("not signed in");
  });

  test("failures below the escalation threshold say degraded without the escalated flag", async () => {
    const home = await withRefreshState(await mkdtemp(join(tmpdir(), "ais-doctor-ali-")), {
      ...FAILED_ENTRY,
      consecutiveFailures: 1,
    });
    const result = await probeAliDoctor(identity(), home);
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("1 consecutive");
    expect(result.detail).not.toContain("escalated");
  });

  test("a healthy last attempt (error cleared) is responsive", async () => {
    const home = await withRefreshState(await mkdtemp(join(tmpdir(), "ais-doctor-ali-")), {
      ...FAILED_ENTRY,
      lastAttemptAt: "2026-09-10T02:00:00.000Z",
      lastSuccessAt: "2026-09-10T02:00:00.000Z",
      lastError: null,
      consecutiveFailures: 0,
    });
    const result = await probeAliDoctor(identity(), home);
    expect(result.status).toBe("responsive");
  });

  test("another tool's failure record does not degrade ali", async () => {
    const home = await withRefreshState(await mkdtemp(join(tmpdir(), "ais-doctor-ali-")), {
      ...FAILED_ENTRY,
      tool: "zai",
    });
    const result = await probeAliDoctor(identity(), home);
    expect(result.status).toBe("responsive");
  });
});

describe("formatDoctorReport: degraded status", () => {
  function degraded(detail: string): DoctorResult {
    return { toolName: "ali", identity: identity("personal"), status: "degraded", detail };
  }

  test("degraded rows render the red label and their detail", () => {
    const output = formatDoctorReport([degraded("console cookie auto-refresh failing (41 consecutive): not signed in")]);
    expect(output).toContain("degraded");
    expect(output).toContain("41 consecutive");
    expect(output).not.toContain("s)"); // no elapsed-time suffix: no subprocess ran
  });

  test("degraded identities are called out in a trailing summary line", () => {
    const output = formatDoctorReport([
      { toolName: "claude", identity: identity("personal"), status: "responsive", elapsedMs: 100 },
      degraded("failing"),
    ]);
    const lines = output.split("\n");
    expect(lines[lines.length - 1]).toContain("Degraded: ali/personal");
    expect(output).toContain("Degraded:");
  });

  test("no degraded summary line when everything is healthy", () => {
    const output = formatDoctorReport([
      { toolName: "claude", identity: identity("personal"), status: "responsive", elapsedMs: 100 },
    ]);
    expect(output).not.toContain("Degraded:");
  });
});
