import { expect, test } from "bun:test";
import { createProgressTracker, etaSeconds, formatBytesPair, formatDuration, formatProgressLine } from "../src/shared/backup-progress.ts";

const GB = 1024 ** 3;

test("duration and byte formatting", () => {
  expect(formatDuration(45)).toBe("45s");
  expect(formatDuration(80)).toBe("1m20s");
  expect(formatDuration(3720)).toBe("1h02m");
  expect(formatBytesPair(3.1 * GB, 7.4 * GB)).toBe("3.1 / 7.4 GB");
  expect(formatBytesPair(512, 2048)).toBe("0.5 / 2.0 KB");
});

test("ETA is undefined until enough samples span enough time", () => {
  expect(etaSeconds([{ at: 0, done: 0 }, { at: 500, done: 10 }], 100)).toBeUndefined();
  expect(etaSeconds([{ at: 0, done: 0 }, { at: 200, done: 5 }, { at: 400, done: 10 }], 100)).toBeUndefined();
  expect(etaSeconds([{ at: 0, done: 0 }, { at: 1000, done: 10 }, { at: 2000, done: 20 }], 100)).toBe(8);
});

test("progress line matches the owner's format and says estimating early", () => {
  let now = 0;
  const t = createProgressTracker(() => now);
  expect(t.line()).toBe("still backing up (measuring, elapsed 0s)");
  const total = 7.4 * GB;
  t.report({ totalBytes: total, doneBytes: 0 });
  now = 1000;
  t.report({ totalBytes: total, doneBytes: 1 * GB });
  expect(t.line()).toBe("backing up 13% (1.0 / 7.4 GB), ETA estimating... (elapsed 1s)");
  now = 2000;
  t.report({ totalBytes: total, doneBytes: 2 * GB });
  now = 45_000;
  t.report({ totalBytes: total, doneBytes: 3.1 * GB });
  // Average rate 3.1 GB over 45 s leaves 4.3 GB: about 62 s.
  const line = t.line();
  expect(line).toBe("backing up 41% (3.1 / 7.4 GB), ETA 1m02s (elapsed 45s)");
  console.log(`ais update: ${line}`);
});

test("a later phase replaces the ETA so 100% does not look stuck", () => {
  let now = 0;
  const t = createProgressTracker(() => now);
  t.report({ totalBytes: 100, doneBytes: 100 });
  now = 7000;
  t.report({ phase: "snapshotting databases" });
  expect(t.line()).toBe("backing up 100% (100.0 / 100.0 B), snapshotting databases (elapsed 7s)".replace("100.0 / 100.0 B", "100 / 100 B"));
});

test("zero total and restart", () => {
  expect(formatProgressLine({ totalBytes: 0, doneBytes: 0 }, [], 5000)).toContain("nothing new to copy");
  let now = 0;
  const t = createProgressTracker(() => now);
  t.report({ totalBytes: 100, doneBytes: 50 });
  now = 1000;
  t.report({ totalBytes: 100, doneBytes: 10 });
  expect(t.line()).toContain("ETA estimating...");
});
