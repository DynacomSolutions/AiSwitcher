import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const scratchRoot = process.env.HOST_TEST_SCRATCH;
const expectBin = process.env.AIS_EXPECT_BIN ?? Bun.which("expect");
const script = resolve(import.meta.dir, "../../image/test/host-exchange.sh");
const canRun = Boolean(scratchRoot && expectBin);

async function runCase(contents: string, caseName: string, timeout = "1") {
  const scratch = join(scratchRoot!, "expect-regression", randomUUID());
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const serial = join(scratch, "serial");
  await writeFile(serial, contents, { mode: 0o600 });
  return Bun.spawnSync(["bash", script, "wait-case", serial, caseName, timeout], {
    env: { ...Bun.env, AIS_EXPECT_BIN: expectBin! },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runTimeoutCase() {
  const scratch = join(scratchRoot!, "expect-regression", randomUUID());
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const serial = join(scratch, "serial");
  const fifo = Bun.spawnSync(["mkfifo", serial], { stdout: "pipe", stderr: "pipe" });
  if (fifo.exitCode !== 0) throw new Error("mkfifo is required for the Expect timeout regression");
  const reader = Bun.spawn(["bash", script, "wait-case", serial, "boot", "1"], {
    env: { ...Bun.env, AIS_EXPECT_BIN: expectBin! },
    stdout: "ignore",
    stderr: "pipe",
  });
  const writer = Bun.spawn(["bash", "-c", 'exec 3>"$1"; sleep 1.5', "host-exchange-writer", serial], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const timeout = setTimeout(() => {
    try { reader.kill(); } catch { /* completed */ }
    try { writer.kill(); } catch { /* completed */ }
  }, 4_000);
  try {
    const [exitCode, stderr] = await Promise.all([reader.exited, new Response(reader.stderr).text()]);
    await writer.exited;
    return { exitCode, stderr: new TextEncoder().encode(stderr) };
  } finally {
    clearTimeout(timeout);
    try { reader.kill(); } catch { /* completed */ }
    try { writer.kill(); } catch { /* completed */ }
  }
}

test.skipIf(!canRun)("host exchange wait-case tracks success, guest failure, invalid case and timeout", async () => {
  const success = await runCase("AIS-EXCHANGE-TEST: case=boot status=pass\n", "boot");
  expect(success.exitCode).toBe(0);

  const failure = await runCase("AIS-EXCHANGE-TEST: case=boot status=fail reason=SYNTHETIC_FIXTURE_failure\n", "boot");
  expect(failure.exitCode).toBe(1);
  expect(new TextDecoder().decode(failure.stderr)).toContain("exchange case boot failed");

  const unknown = await runCase("", "SYNTHETIC_FIXTURE_unknown");
  expect(unknown.exitCode).toBe(1);
  expect(new TextDecoder().decode(unknown.stderr)).toContain("unknown exchange case");

  const timeout = await runTimeoutCase();
  expect(timeout.exitCode).toBe(1);
  expect(new TextDecoder().decode(timeout.stderr)).toContain("timed out waiting");
}, 10_000);
