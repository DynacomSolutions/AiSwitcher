import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiAdapter, kimiHome } from "../../src/acp/kimi-turn.ts";

const root = await mkdtemp(join(tmpdir(), "ais-kimi-turn-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let n = 0;
/** A kimi-code home with one session, and the path of its wire log. */
async function session(id: string): Promise<{ home: string; log: string }> {
  const home = join(root, `home${++n}`);
  const dir = join(home, "sessions", "wd_synthetic_1a2b", id, "agents", "main");
  await mkdir(dir, { recursive: true });
  await mkdir(join(home, "sessions", "wd_other_3c4d"), { recursive: true });
  return { home, log: join(dir, "wire.jsonl") };
}
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
// Every line carries the same time: the reader must never depend on clocks.
const ended = (reason: string, error?: unknown) => line({ type: "turn.ended", time: 5000, turnId: "t", reason, ...(error ? { error } : {}) });
const prompted = () => line({ type: "turn.prompt", time: 5000 });
const API_400 = { code: "provider.api_error", message: "Invalid request Error", retryable: false, details: { statusCode: 400 } };
const noWait = { waitMs: 0, sleep: async () => {} };

test("a failed turn gives the agent's own reason", async () => {
  const { home, log } = await session("session_a");
  await writeFile(log, prompted() + ended("completed"));
  const a = kimiAdapter(home, noWait);
  const mark = a.promptStarting!("session_a");
  await appendFile(log, prompted() + ended("failed", API_400));
  expect(await a.turnOutcome!("session_a", mark)).toEqual({ message: "Invalid request Error", code: "provider.api_error", status: 400, retryable: false });
});

test("a completed or cancelled turn is known to have ended without a failure", async () => {
  const { home, log } = await session("session_b");
  await writeFile(log, ended("failed", API_400));
  const a = kimiAdapter(home, noWait);
  for (const reason of ["completed", "cancelled", "blocked"]) {
    const mark = a.promptStarting!("session_b");
    await appendFile(log, prompted() + ended(reason));
    expect(await a.turnOutcome!("session_b", mark)).toBe("ok");
  }
});

test("the failure of an earlier turn is never reported for this one, whatever the clocks say", async () => {
  const { home, log } = await session("session_c");
  await writeFile(log, prompted() + ended("failed", API_400));
  const a = kimiAdapter(home, noWait);
  const mark = a.promptStarting!("session_c");
  expect(await a.turnOutcome!("session_c", mark)).toBeUndefined(); // nothing written for this turn yet
  await appendFile(log, prompted()); // the turn is under way
  expect(await a.turnOutcome!("session_c", mark)).toBeUndefined();
  await appendFile(log, ended("completed"));
  expect(await a.turnOutcome!("session_c", mark)).toBe("ok");
});

test("the first prompt of a session whose log does not exist yet", async () => {
  const { home, log } = await session("session_new");
  const a = kimiAdapter(home, noWait);
  const mark = a.promptStarting!("session_new");
  expect(mark).toEqual({ size: 0 });
  await writeFile(log, prompted() + ended("failed", API_400));
  expect((await a.turnOutcome!("session_new", mark) as { status: number }).status).toBe(400);
});

test("waits a short time for the line of this turn", async () => {
  const { home, log } = await session("session_d");
  await writeFile(log, ended("completed"));
  let sleeps = 0;
  const adapter = kimiAdapter(home, {
    waitMs: 600,
    sleep: async () => {
      if (++sleeps === 3) await appendFile(log, ended("failed", { code: "provider.rate_limit", message: "Too many requests", retryable: true, details: { statusCode: 429 } }));
    },
  });
  expect(await adapter.turnOutcome!("session_d", adapter.promptStarting!("session_d"))).toEqual({ message: "Too many requests", code: "provider.rate_limit", status: 429, retryable: true });
  expect(sleeps).toBe(3);
  // and gives up when it never comes
  let more = 0;
  const idle = kimiAdapter(home, { waitMs: 200, sleep: async () => void more++ });
  expect(await idle.turnOutcome!("session_d", idle.promptStarting!("session_d"))).toBeUndefined();
  expect(more).toBe(5);
});

test("a failed turn without details still reads", async () => {
  const { home, log } = await session("session_e");
  await writeFile(log, "");
  const a = kimiAdapter(home, noWait);
  const mark = a.promptStarting!("session_e");
  await appendFile(log, ended("failed"));
  expect(await a.turnOutcome!("session_e", mark)).toEqual({ message: "the provider request failed" });
});

test("only the end of a large turn is read, and a cut first line is skipped", async () => {
  const big = line({ type: "context.append_message", time: 1, message: { role: "tool", content: `"turn.ended" ${"x".repeat(1024 * 1024 + 4096)}` } });
  const { home, log } = await session("session_f");
  await writeFile(log, ended("completed"));
  const a = kimiAdapter(home, noWait);
  const mark = a.promptStarting!("session_f");
  await appendFile(log, prompted() + big + line({ type: "llm.request", time: 5000 }) + ended("failed", API_400));
  expect((await a.turnOutcome!("session_f", mark) as { status: number }).status).toBe(400);
  // the only turn.ended of this turn is before the part that is read: nothing is known
  const other = await session("session_g");
  await writeFile(other.log, "");
  const b = kimiAdapter(other.home, noWait);
  const markB = b.promptStarting!("session_g");
  await appendFile(other.log, ended("failed", API_400) + big);
  expect(await b.turnOutcome!("session_g", markB)).toBeUndefined();
});

test("a log that became shorter (a session rollback) is read from its start", async () => {
  const { home, log } = await session("session_r");
  await writeFile(log, prompted().repeat(50) + ended("completed"));
  const a = kimiAdapter(home, noWait);
  const mark = a.promptStarting!("session_r");
  await writeFile(log, prompted() + ended("failed", API_400));
  expect((await a.turnOutcome!("session_r", mark) as { status: number }).status).toBe(400);
});

test("an unknown session, a missing home and an unsafe id: nothing is known", async () => {
  const { home } = await session("session_h");
  for (const [h, id] of [[home, "session_missing"], [join(root, "no-such-home"), "session_h"], [home, "../session_h"]] as const) {
    const a = kimiAdapter(h, noWait);
    expect(a.promptStarting!(id)).toEqual({ size: 0 });
    expect(await a.turnOutcome!(id, a.promptStarting!(id))).toBeUndefined();
  }
  expect(await kimiAdapter(home, noWait).turnOutcome!("session_h", "not a mark")).toBeUndefined();
});

test("kimiHome: KIMI_CODE_HOME, or ~/.kimi-code", () => {
  expect(kimiHome({ KIMI_CODE_HOME: "/x/kimi" }, "/srv/u")).toBe("/x/kimi");
  expect(kimiHome({}, "/srv/u")).toBe("/srv/u/.kimi-code");
});

// In-turn limit watch: a long usage-limit retry inside an open turn. The clock is fixed so the horizon is deterministic.
const NOW_MS = Date.parse("2026-11-24T12:00:00Z");
const LONG_RESET = "2026-11-27T03:31:45.000Z"; // about 71 h away
const SHORT_RESET = "2026-11-24T12:00:30Z"; // 30 s away, under the two-minute horizon
const retry = (o: { status?: number; name?: string; message?: string } = {}) =>
  line({
    type: "turn.step.retrying", agentId: "main", turnId: 0, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 10,
    delayMs: 256304000, errorName: o.name ?? "APIProviderRateLimitError",
    errorMessage: o.message ?? `You've hit your usage limit (SYNTHETIC_FIXTURE). Resets at ${LONG_RESET}.`,
    statusCode: o.status ?? 429, time: 5000,
  });
const inTurnAdapter = (home: string) => kimiAdapter(home, { now: () => NOW_MS });

test("inTurnLimit: a 429 retry with a reset over two minutes away is a long limit", async () => {
  const { home, log } = await session("session_it1");
  await writeFile(log, prompted());
  const a = inTurnAdapter(home);
  const mark = a.promptStarting!("session_it1");
  await appendFile(log, retry());
  expect(await a.inTurnLimit!("session_it1", mark)).toEqual({
    message: `You've hit your usage limit (SYNTHETIC_FIXTURE). Resets at ${LONG_RESET}.`,
    code: "APIProviderRateLimitError", status: 429,
  });
});

test("inTurnLimit: a short burst, no reset text, or a non-limit error is ignored", async () => {
  const { home, log } = await session("session_it2");
  await writeFile(log, "");
  const a = inTurnAdapter(home);
  const cases = [
    retry({ message: `Rate limit (SYNTHETIC_FIXTURE). Resets at ${SHORT_RESET}.` }), // burst under the horizon
    retry({ message: "You've hit your usage limit (SYNTHETIC_FIXTURE)." }), // no reset text
    retry({ status: 500, name: "APIProviderError", message: `Server error (SYNTHETIC_FIXTURE). Resets at ${LONG_RESET}.` }), // not a limit
  ];
  for (const c of cases) {
    const mark = a.promptStarting!("session_it2");
    await appendFile(log, c);
    expect(await a.inTurnLimit!("session_it2", mark)).toBeUndefined();
  }
});

test("inTurnLimit: a rate-limit error name is enough without a 429 status", async () => {
  const { home, log } = await session("session_it3");
  await writeFile(log, "");
  const a = inTurnAdapter(home);
  const mark = a.promptStarting!("session_it3");
  await appendFile(log, line({ type: "turn.step.retrying", errorName: "APIProviderRateLimitError", errorMessage: `Usage limit (SYNTHETIC_FIXTURE). Resets at ${LONG_RESET}.`, time: 5000 }));
  expect((await a.inTurnLimit!("session_it3", mark))?.code).toBe("APIProviderRateLimitError");
});

test("inTurnLimit: only retries after the prompt mark count, and the newest one wins", async () => {
  const { home, log } = await session("session_it4");
  await writeFile(log, retry()); // a retry of an earlier turn
  const a = inTurnAdapter(home);
  const mark = a.promptStarting!("session_it4");
  expect(await a.inTurnLimit!("session_it4", mark)).toBeUndefined(); // before the mark
  await appendFile(log, retry());
  expect((await a.inTurnLimit!("session_it4", mark))?.status).toBe(429);
  await appendFile(log, retry({ message: `Rate limit (SYNTHETIC_FIXTURE). Resets at ${SHORT_RESET}.` })); // newest is a burst
  expect(await a.inTurnLimit!("session_it4", mark)).toBeUndefined();
});

test("inTurnLimit: a turn.ended line is not a retry, and an unknown session gives nothing", async () => {
  const { home, log } = await session("session_it5");
  await writeFile(log, "");
  const a = inTurnAdapter(home);
  const mark = a.promptStarting!("session_it5");
  await appendFile(log, ended("failed", { code: "provider.rate_limit", message: `Usage limit (SYNTHETIC_FIXTURE). Resets at ${LONG_RESET}.`, retryable: true, details: { statusCode: 429 } }));
  expect(await a.inTurnLimit!("session_it5", mark)).toBeUndefined();
  expect(await a.inTurnLimit!("session_missing", mark)).toBeUndefined();
});
