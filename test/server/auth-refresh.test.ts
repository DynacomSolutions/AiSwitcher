import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../../src/identities/types.ts";
import { OAuthRefreshError } from "../../src/identities/oauth-refresh.ts";
import {
  AuthRefreshScheduler,
  ESCALATION_THRESHOLD,
  lastRefreshFailure,
  parseRefreshExpiryWindowHours,
  parseRefreshIntervalMs,
} from "../../src/server/auth-refresh.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStateHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-refresh-"));
  tempDirs.push(dir);
  return dir;
}

/** Every scheduler gets an explicit temp stateHome: os.homedir() is cached
 * from the spawn environment, so an env-var HOME change at runtime does NOT
 * isolate persist()/hydrate(); without injection these tests silently
 * read/wrote the real daemon's ~/.ais/web/auth-refresh-state.json. */
async function makeScheduler(
  refresher: (identity: Identity, context: { force: boolean; lastSuccessAt: string | null; revokedFingerprint?: string; expiryWindowHours: number }) => Promise<string | { skipped: boolean; detail: string } | undefined>,
  identities: Identity[] = [{ name: "personal", label: "personal", configDir: "/tmp/ali-personal" }],
): Promise<{ scheduler: AuthRefreshScheduler; stateHome: string }> {
  const stateHome = await tempStateHome();
  return { scheduler: new AuthRefreshScheduler(0, { ali: refresher }, async () => identities, stateHome), stateHome };
}

function statePathFor(stateHome: string): string {
  return join(stateHome, ".ais", "web", "auth-refresh-state.json");
}

function countingRefresher(failFirst: number) {
  let calls = 0;
  const seen: string[] = [];
  return {
    seen,
    refresher: async (identity: { name: string }) => {
      calls += 1;
      seen.push(identity.name);
      if (calls <= failFirst) throw new Error(`flaky failure #${calls}`);
      return `/tmp/console-cookie-${identity.name}.txt`;
    },
    get calls() {
      return calls;
    },
  };
}

describe("AuthRefreshScheduler", () => {
  test("refreshNow records success and clears the error", async () => {
    const { refresher } = countingRefresher(0);
    const { scheduler } = await makeScheduler(refresher);
    const success = await scheduler.refreshNow("ali", "personal");
    expect(success).toBe(true);
    const status = scheduler.status();
    expect(status).toHaveLength(1);
    expect(status[0].lastError).toBeNull();
    expect(status[0].lastSuccessAt).not.toBeNull();
  });

  test("failures land in lastError and a later success clears them", async () => {
    const { refresher } = countingRefresher(1);
    const { scheduler } = await makeScheduler(refresher);
    const first = await scheduler.refreshNow("ali", "personal");
    expect(first).toBe(false);
    expect(scheduler.status()[0].lastError).toContain("flaky failure #1");
    const second = await scheduler.refreshNow("ali", "personal");
    expect(second).toBe(true);
    expect(scheduler.status()[0].lastError).toBeNull();
  });

  test("refreshNow rejects unknown tools and identities", async () => {
    const { refresher } = countingRefresher(0);
    const { scheduler } = await makeScheduler(refresher);
    await scheduler.refreshNow("claude", "personal").then(
      () => expect.unreachable(),
      (error: Error) => expect(error.message).toContain("no refresh flow"),
    );
    await scheduler.refreshNow("ali", "does-not-exist").then(
      () => expect.unreachable(),
      (error: Error) => expect(error.message).toContain("does-not-exist"),
    );
  });

  test("interval 0 disables the scheduler but refreshNow still works", async () => {
    const counter = countingRefresher(0);
    const { scheduler } = await makeScheduler(counter.refresher);
    expect(scheduler.enabled).toBe(false);
    scheduler.start();
    await scheduler.refreshNow("ali", "personal");
    expect(counter.calls).toBe(1);
    scheduler.stop();
  });

  test("parseRefreshIntervalMs falls back on garbage and honours zero", () => {
    expect(parseRefreshIntervalMs(undefined)).toBe(600_000);
    expect(parseRefreshIntervalMs("")).toBe(600_000);
    expect(parseRefreshIntervalMs("nonsense")).toBe(600_000);
    expect(parseRefreshIntervalMs("-5")).toBe(600_000);
    expect(parseRefreshIntervalMs("0")).toBe(0);
    expect(parseRefreshIntervalMs("60000")).toBe(60_000);
  });

  test("consecutive failures count up, escalate at the threshold, and a success resets", async () => {
    let calls = 0;
    const refresher = async () => {
      calls += 1;
      if (calls <= ESCALATION_THRESHOLD + 1) throw new Error(`failure #${calls}`);
      return "/tmp/console-cookie-personal.txt";
    };
    const { scheduler } = await makeScheduler(refresher);

    for (let i = 1; i <= ESCALATION_THRESHOLD + 1; i++) {
      await scheduler.refreshNow("ali", "personal");
      const status = scheduler.status()[0];
      expect(status.consecutiveFailures).toBe(i);
      expect(status.lastError).toContain(`failure #${i}`);
    }

    await scheduler.refreshNow("ali", "personal");
    const recovered = scheduler.status()[0];
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastError).toBeNull();
    expect(recovered.lastSuccessAt).not.toBeNull();
  });

  test("every failed attempt logs one loud stderr line", async () => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (line: string) => logs.push(line);
    try {
      const { scheduler } = await makeScheduler(async () => undefined);
      await scheduler.refreshNow("ali", "personal");
    } finally {
      console.error = original;
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[ais auth-refresh]");
    expect(logs[0]).toContain("ali/personal");
    expect(logs[0]).toContain("1 consecutive");
  });

  test("hydrating a pre-consecutiveFailures state file defaults the counter to 0", async () => {
    const stateHome = await tempStateHome();
    await mkdir(join(stateHome, ".ais", "web"), { recursive: true });
    await writeFile(
      statePathFor(stateHome),
      JSON.stringify({
        entries: [
          {
            tool: "ali",
            identity: "personal",
            lastAttemptAt: "2026-09-10T01:38:14.927Z",
            lastSuccessAt: "2026-09-05T10:30:56.178Z",
            lastError: "refresh returned nothing (session not authenticated or browser unavailable)",
          },
        ],
      }),
    );
    const scheduler = new AuthRefreshScheduler(0, { ali: async () => undefined }, async () => [], stateHome);
    scheduler.hydrate();
    await Bun.sleep(20);
    const status = scheduler.status();
    expect(status).toHaveLength(1);
    expect(status[0].consecutiveFailures).toBe(0);
    expect(status[0].lastError).toContain("refresh returned nothing");
  });

  test("state file round-trips consecutiveFailures for the next process", async () => {
    const { scheduler, stateHome } = await makeScheduler(async () => undefined);
    await scheduler.refreshNow("ali", "personal");
    const raw = JSON.parse(await readFile(statePathFor(stateHome), "utf8")) as { entries: { consecutiveFailures?: number }[] };
    expect(raw.entries[0].consecutiveFailures).toBe(1);
  });
});

describe("lastRefreshFailure", () => {
  test("returns undefined when the state file is missing", async () => {
    const dir = await tempStateHome();
    expect(await lastRefreshFailure("ali", "personal", dir)).toBeUndefined();
  });

  test("returns the failed attempt with its consecutive count", async () => {
    const dir = await tempStateHome();
    await mkdir(join(dir, ".ais", "web"), { recursive: true });
    await writeFile(
      statePathFor(dir),
      JSON.stringify({
        entries: [
          {
            tool: "ali",
            identity: "personal",
            lastAttemptAt: "2026-09-10T01:38:14.927Z",
            lastSuccessAt: "2026-09-05T10:30:56.178Z",
            lastError: "the auth browser is not signed in",
            consecutiveFailures: 41,
          },
        ],
      }),
    );
    const failure = await lastRefreshFailure("ali", "personal", dir);
    expect(failure?.lastAttemptAt).toBe("2026-09-10T01:38:14.927Z");
    expect(failure?.lastError).toBe("the auth browser is not signed in");
    expect(failure?.consecutiveFailures).toBe(41);
    expect(await lastRefreshFailure("ali", "other", dir)).toBeUndefined();
  });

  test("returns undefined once the last attempt succeeded (failure summaries explain only ACTIVE problems)", async () => {
    const dir = await tempStateHome();
    await mkdir(join(dir, ".ais", "web"), { recursive: true });
    await writeFile(
      statePathFor(dir),
      JSON.stringify({
        entries: [
          {
            tool: "ali",
            identity: "personal",
            lastAttemptAt: "2026-09-10T02:00:00.000Z",
            lastSuccessAt: "2026-09-10T02:00:00.000Z",
            lastError: null,
            consecutiveFailures: 0,
          },
        ],
      }),
    );
    expect(await lastRefreshFailure("ali", "personal", dir)).toBeUndefined();
  });

  test("a stale error dated BEFORE the last success is not a live failure", async () => {
    const dir = await tempStateHome();
    await mkdir(join(dir, ".ais", "web"), { recursive: true });
    await writeFile(
      statePathFor(dir),
      JSON.stringify({
        entries: [
          {
            tool: "ali",
            identity: "personal",
            lastAttemptAt: "2026-09-01T00:00:00.000Z",
            lastSuccessAt: "2026-09-05T10:30:56.178Z",
            lastError: "ancient error a hand-edited file kept alive",
          },
        ],
      }),
    );
    expect(await lastRefreshFailure("ali", "personal", dir)).toBeUndefined();
  });
});

describe("OAuth refresher outcomes", () => {
  test("a deliberate skip is recorded with its reason, never a failure", async () => {
    let seenContext: unknown;
    const { scheduler } = await makeScheduler(async (_identity, context) => {
      seenContext = context;
      return { skipped: true, detail: "access token expires in 31h - nothing to do" };
    });
    const ok = await scheduler.refreshNow("ali", "personal");
    expect(ok).toBe(true);
    const status = scheduler.status()[0]!;
    expect(status.lastError).toBeNull();
    expect(status.lastDetail).toBe("access token expires in 31h - nothing to do");
    // A skip must not refresh the last-success stamp: the daily keep-alive
    // floor depends on it.
    expect(status.lastSuccessAt).toBeNull();
    expect(seenContext).toBeDefined();
  });

  test("manual runs force past the cadence skip; ticks do not", async () => {
    const forces: boolean[] = [];
    const refresher = async (_identity: Identity, context: { force: boolean }) => {
      forces.push(context.force);
      return "refreshed";
    };
    const { scheduler } = await makeScheduler(refresher);
    await scheduler.refreshNow("ali", "personal");
    await scheduler.tick();
    expect(forces).toEqual([true, false]);
  });

  test("a revoked diagnosis is pinned to the grant's fingerprint and exposed on the DTO", async () => {
    let attempts = 0;
    const contexts: Array<string | undefined> = [];
    const refresher = async (_identity: Identity, context: { revokedFingerprint?: string }) => {
      contexts.push(context.revokedFingerprint);
      attempts += 1;
      throw new OAuthRefreshError("refresh token revoked - re-login required: run the real CLI", true, "fp1234");
    };
    const { scheduler } = await makeScheduler(refresher);
    const first = await scheduler.refreshNow("ali", "personal");
    expect(first).toBe(false);
    const status = scheduler.status()[0]!;
    expect(status.revoked).toBe(true);
    expect(status.lastError).toContain("re-login required");

    // Second attempt: the scheduler hands the pinned fingerprint back so
    // the refresher can skip instead of hammering the endpoint (never loop).
    await scheduler.refreshNow("ali", "personal");
    expect(attempts).toBe(2);
    expect(contexts[1]).toBe("fp1234");
  });

  test("a successful refresh clears the revoked diagnosis", async () => {
    let fail = true;
    const refresher = async () => {
      if (fail) throw new OAuthRefreshError("refresh token revoked", true, "fp-dead");
      return "refreshed after re-login";
    };
    const { scheduler } = await makeScheduler(refresher);
    await scheduler.refreshNow("ali", "personal");
    fail = false;
    await scheduler.refreshNow("ali", "personal");
    const status = scheduler.status()[0]!;
    expect(status.revoked).toBe(false);
    expect(status.lastError).toBeNull();
    expect(status.lastDetail).toBe("refreshed after re-login");
  });

  test("undefined is still a failure, string a success with detail", async () => {
    const { scheduler } = await makeScheduler(async () => undefined);
    expect(await scheduler.refreshNow("ali", "personal")).toBe(false);
    expect(scheduler.status()[0]!.lastError).toContain("refresh returned nothing");
  });

  test("parseRefreshExpiryWindowHours defaults to 24 and ignores junk", () => {
    expect(parseRefreshExpiryWindowHours(undefined)).toBe(24);
    expect(parseRefreshExpiryWindowHours("")).toBe(24);
    expect(parseRefreshExpiryWindowHours("nonsense")).toBe(24);
    expect(parseRefreshExpiryWindowHours("0")).toBe(24);
    expect(parseRefreshExpiryWindowHours("12")).toBe(12);
  });
});
