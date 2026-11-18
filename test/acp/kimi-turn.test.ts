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
const ended = (time: number, reason: string, error?: unknown) => line({ type: "turn.ended", time, turnId: "t", reason, ...(error ? { error } : {}) });
const API_400 = { code: "provider.api_error", message: "Invalid request Error", retryable: false, details: { statusCode: 400 } };
const noWait = { waitMs: 0, sleep: async () => {} };

test("a failed turn gives the agent's own reason", async () => {
  const { home, log } = await session("session_a");
  await writeFile(log, line({ type: "turn.prompt", time: 4990 }) + ended(5000, "failed", API_400));
  expect(await kimiAdapter(home, noWait).turnFailure!("session_a", 4980)).toEqual({ message: "Invalid request Error", code: "provider.api_error", status: 400, retryable: false });
});

test("a completed or cancelled turn is not a failure", async () => {
  const { home, log } = await session("session_b");
  await writeFile(log, ended(4000, "failed", API_400) + ended(5000, "completed"));
  expect(await kimiAdapter(home, noWait).turnFailure!("session_b", 4500)).toBeUndefined();
  await appendFile(log, ended(6000, "cancelled"));
  expect(await kimiAdapter(home, noWait).turnFailure!("session_b", 5500)).toBeUndefined();
});

test("the failure of an earlier turn is never reported for this one", async () => {
  const { home, log } = await session("session_c");
  await writeFile(log, ended(4000, "failed", API_400));
  expect(await kimiAdapter(home, noWait).turnFailure!("session_c", 4500)).toBeUndefined();
});

test("waits a short time for the line of this turn", async () => {
  const { home, log } = await session("session_d");
  await writeFile(log, ended(4000, "completed"));
  let sleeps = 0;
  const adapter = kimiAdapter(home, {
    waitMs: 600,
    sleep: async () => {
      if (++sleeps === 3) await appendFile(log, ended(5000, "failed", { code: "provider.rate_limit", message: "Too many requests", retryable: true, details: { statusCode: 429 } }));
    },
  });
  expect(await adapter.turnFailure!("session_d", 4500)).toEqual({ message: "Too many requests", code: "provider.rate_limit", status: 429, retryable: true });
  expect(sleeps).toBe(3);
  // and gives up when it never comes
  let more = 0;
  const idle = kimiAdapter(home, { waitMs: 200, sleep: async () => void more++ });
  expect(await idle.turnFailure!("session_d", 9000)).toBeUndefined();
  expect(more).toBe(5);
});

test("a failed turn without details still reads", async () => {
  const { home, log } = await session("session_e");
  await writeFile(log, ended(5000, "failed"));
  expect(await kimiAdapter(home, noWait).turnFailure!("session_e", 4000)).toEqual({ message: "the provider request failed" });
});

test("only the end of a large log is read, and a cut first line is skipped", async () => {
  const { home, log } = await session("session_f");
  const big = line({ type: "context.append_message", time: 1, message: { role: "user", content: "x".repeat(1024 * 1024 + 4096) } });
  await writeFile(log, ended(4000, "completed") + big + line({ type: "llm.request", time: 4999 }) + ended(5000, "failed", API_400));
  expect((await kimiAdapter(home, noWait).turnFailure!("session_f", 4500))?.status).toBe(400);
  // the only turn.ended is before the part that is read
  const other = await session("session_g");
  await writeFile(other.log, ended(5000, "failed", API_400) + big);
  expect(await kimiAdapter(other.home, noWait).turnFailure!("session_g", 4500)).toBeUndefined();
});

test("an unknown session, a missing home and an unsafe id are not failures", async () => {
  const { home } = await session("session_h");
  expect(await kimiAdapter(home, noWait).turnFailure!("session_missing", 0)).toBeUndefined();
  expect(await kimiAdapter(join(root, "no-such-home"), noWait).turnFailure!("session_h", 0)).toBeUndefined();
  expect(await kimiAdapter(home, noWait).turnFailure!("../session_h", 0)).toBeUndefined();
});

test("kimiHome: KIMI_CODE_HOME, or ~/.kimi-code", () => {
  expect(kimiHome({ KIMI_CODE_HOME: "/x/kimi" }, "/srv/u")).toBe("/x/kimi");
  expect(kimiHome({}, "/srv/u")).toBe("/srv/u/.kimi-code");
});
