import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateIdentityLocalSpend,
  fileTextChunks,
  listRecentFiles,
  readIdentityLocalSpend,
  readIdentityLocalSpendAsync,
  recordsFromClaudeProjectLog,
  recordsFromCodexRollout,
} from "../../src/shared/local-spend.ts";

const MONTH_START = new Date(2026, 8, 1); // 1 Sep 2026 local

/** A realistic codex rollout slice: session_meta, a turn_context naming the
 * model, then token_count deltas (input_tokens covers its cached subsets). */
function codexLine(kind: string, extra: Record<string, unknown> = {}): string {
  if (kind === "turn_context") {
    return JSON.stringify({ timestamp: "2026-09-02T03:00:00.000Z", type: "turn_context", payload: { model: "openai.gpt-6-astra", ...extra } });
  }
  return JSON.stringify({
    timestamp: "2026-09-02T03:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 900,
          output_tokens: 50,
          ...(extra.usage ?? {}),
        },
        model_context_window: 258400,
      },
    },
  });
}

describe("recordsFromCodexRollout", () => {
  test("values deltas with the most recent turn_context model; cached subsets partition input", () => {
    const records = recordsFromCodexRollout([codexLine("turn_context"), codexLine("token_count")].join("\n"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: "openai.gpt-6-astra", input: 100, cacheRead: 0, cacheWrite: 900, output: 50 });
  });

  test("cached_input_tokens above the remainder clamps, never goes negative", () => {
    const records = recordsFromCodexRollout(
      codexLine("token_count", { usage: { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 80, output_tokens: 0 } }),
    );
    expect(records[0]).toMatchObject({ input: 0, cacheRead: 80, cacheWrite: 20 });
  });

  test("events before any turn_context still count, priced conservatively as unknown", () => {
    const records = recordsFromCodexRollout(codexLine("token_count"));
    expect(records[0]?.model).toBe("unknown");
  });

  test("a torn trailing line is skipped, not fatal", () => {
    const records = recordsFromCodexRollout(`${codexLine("token_count")}\n{"timestamp":"2026-09-02T03:00:0`);
    expect(records).toHaveLength(1);
  });
});

describe("recordsFromClaudeProjectLog", () => {
  test("reads assistant usage lines; claude's input field is uncached new input", () => {
    const line = JSON.stringify({
      timestamp: "2026-09-02T04:42:49.600Z",
      type: "assistant",
      message: {
        model: "claude-fable-5-1",
        usage: { input_tokens: 2, cache_creation_input_tokens: 31613, cache_read_input_tokens: 7, output_tokens: 9 },
      },
    });
    expect(recordsFromClaudeProjectLog(line)).toEqual([
      { model: "claude-fable-5-1", input: 2, output: 9, cacheRead: 7, cacheWrite: 31613, atMs: Date.parse("2026-09-02T04:42:49.600Z") },
    ]);
  });
});

interface FsFixture {
  files: Record<string, { text: string; mtimeMs: number }>;
  dirs: string[];
}

function fixtureDeps(fixture: FsFixture) {
  return {
    readdir: (path: string): string[] => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const known = fixture.dirs.some((d) => d === path || d.startsWith(prefix)) || Object.keys(fixture.files).some((f) => f.startsWith(prefix));
      if (!known) throw new Error(`ENOENT: ${path}`);
      const names = new Set<string>();
      for (const dir of fixture.dirs) if (dir.startsWith(prefix)) names.add(dir.slice(prefix.length).split("/")[0]!);
      for (const file of Object.keys(fixture.files)) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
      return [...names];
    },
    readText: (path: string): string => fixture.files[path]?.text ?? (() => { throw new Error(`missing ${path}`); })(),
    mtimeMs: (path: string): number => fixture.files[path]?.mtimeMs ?? 0,
    isDirectory: (path: string): boolean => !fixture.files.hasOwnProperty(path),
  };
}

describe("estimateIdentityLocalSpend", () => {
  test("prices period events at Bedrock rates: uncached input, cache read, cache write, output", () => {
    const fixture: FsFixture = {
      dirs: ["/id/sessions"],
      files: {
        "/id/sessions/rollout.jsonl": {
          text: [codexLine("turn_context"), codexLine("token_count")].join("\n"),
          mtimeMs: MONTH_START.getTime() + 1000,
        },
      },
    };
    const result = estimateIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture));
    // (100*11 + 0*1.1 + 900*13.75 + 50*55) / 1e6
    expect(result.usd).toBeCloseTo((100 * 11 + 900 * 13.75 + 50 * 55) / 1_000_000, 10);
    expect(result.unknownModelUsd).toBe(0);
    expect(result.filesRead).toBe(1);
    expect(result.notes).toEqual([]);
  });

  test("events timestamped before the period are skipped (period-filtered, not file-filtered)", () => {
    const oldLine = JSON.stringify({
      timestamp: "2026-08-20T03:00:01.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } } },
    });
    const fixture: FsFixture = {
      dirs: ["/id/sessions"],
      files: {
        "/id/sessions/long-running.jsonl": {
          text: [codexLine("turn_context"), oldLine, codexLine("token_count")].join("\n"),
          mtimeMs: MONTH_START.getTime() + 86_400_000,
        },
      },
    };
    const result = estimateIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture));
    expect(result.usd).toBeCloseTo((100 * 11 + 900 * 13.75 + 50 * 55) / 1_000_000, 10);
  });

  test("unknown models value at the conservative fallback and surface as unknownModelUsd", () => {
    const text = JSON.stringify({
      timestamp: "2026-09-02T03:00:01.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    });
    const fixture: FsFixture = { dirs: ["/id/sessions"], files: { "/id/sessions/r.jsonl": { text, mtimeMs: MONTH_START.getTime() + 1 } } };
    const result = estimateIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture));
    expect(result.usd).toBeCloseTo(11, 6); // table max input rate
    expect(result.unknownModelUsd).toBeCloseTo(11, 6);
  });

  test("a tool with no reader contributes zero with a note; missing session dirs are plain zero", () => {
    expect(estimateIdentityLocalSpend("kimi", "/id", MONTH_START, fixtureDeps({ dirs: [], files: {} })).notes).toEqual([
      'no local session reader for tool "kimi"',
    ]);
    const empty = estimateIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps({ dirs: [], files: {} }));
    expect(empty).toEqual({ usd: 0, unknownModelUsd: 0, filesRead: 0, notes: [] });
  });

  test("a file that fails mid-read does not sink the estimate", () => {
    const deps = fixtureDeps({
      dirs: ["/id/sessions"],
      files: {
        "/id/sessions/good.jsonl": { text: codexLine("token_count"), mtimeMs: MONTH_START.getTime() + 1 },
        "/id/sessions/bad.jsonl": { text: "ignored", mtimeMs: MONTH_START.getTime() + 1 },
      },
    });
    const readText = (path: string): string => {
      if (path.endsWith("bad.jsonl")) throw new Error("EIO");
      return deps.readText(path);
    };
    const result = estimateIdentityLocalSpend("codex", "/id", MONTH_START, { ...deps, readText });
    expect(result.filesRead).toBe(2);
    expect(result.usd).toBeGreaterThan(0);
  });
});

describe("listRecentFiles", () => {
  test("prunes codex year/month/day path branches before the period", () => {
    const fixture: FsFixture = {
      dirs: ["/id/sessions/2026", "/id/sessions/2026/08", "/id/sessions/2026/09", "/id/sessions/2026/09/01", "/id/sessions/2026/09/02"],
      files: {
        "/id/sessions/2026/08/20/old.jsonl": { text: "x", mtimeMs: MONTH_START.getTime() + 1 },
        "/id/sessions/2026/09/01/a.jsonl": { text: "x", mtimeMs: MONTH_START.getTime() + 1 },
        "/id/sessions/2026/09/02/b.jsonl": { text: "x", mtimeMs: MONTH_START.getTime() + 1 },
      },
    };
    const deps = fixtureDeps(fixture);
    const { files } = listRecentFiles("/id/sessions", MONTH_START, deps, true);
    expect(files.sort()).toEqual(["/id/sessions/2026/09/01/a.jsonl", "/id/sessions/2026/09/02/b.jsonl"].sort());
  });

  test("mtime is the authoritative prune: a pre-period path-day file still fresh counts, a stale one does not", () => {
    const fixture: FsFixture = {
      dirs: ["/id/projects/p1", "/id/projects/p2"],
      files: {
        "/id/projects/p1/august-session.jsonl": { text: "x", mtimeMs: MONTH_START.getTime() + 5 },
        "/id/projects/p2/stale.jsonl": { text: "x", mtimeMs: MONTH_START.getTime() - 5 },
      },
    };
    const { files } = listRecentFiles("/id/projects", MONTH_START, fixtureDeps(fixture), false);
    expect(files).toEqual(["/id/projects/p1/august-session.jsonl"]);
  });

  test("a missing root reports unreadable instead of throwing", () => {
    expect(listRecentFiles("/nothing", MONTH_START, fixtureDeps({ dirs: [], files: {} }), true)).toEqual({ files: [], unreadable: true });
  });
});

describe("readIdentityLocalSpend", () => {
  test("returns the same records' token totals, per-model breakdown, daily tokens and span alongside the estimate", () => {
    const fixture: FsFixture = {
      dirs: ["/id/sessions"],
      files: {
        "/id/sessions/rollout.jsonl": {
          text: [
            codexLine("turn_context"),
            codexLine("token_count"),
            codexLine("token_count", { usage: { input_tokens: 2000, cached_input_tokens: 500, cache_write_input_tokens: 0, output_tokens: 100 } }),
          ].join("\n"),
          mtimeMs: MONTH_START.getTime() + 1000,
        },
      },
    };
    const read = readIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture));
    // record 1: input 100, cacheWrite 900, output 50; record 2: input 1500, cacheRead 500, output 100
    expect(read.messages).toBe(2);
    expect(read.input).toBe(1600);
    expect(read.output).toBe(150);
    expect(read.cacheRead).toBe(500);
    expect(read.cacheWrite).toBe(900);
    expect(read.models).toHaveLength(1);
    expect(read.models[0]).toMatchObject({ model: "openai.gpt-6-astra", input: 1600, output: 150, cacheRead: 500, cacheWrite: 900, messageCount: 2 });
    // The per-model valuation matches the record-order estimate total.
    expect(read.models[0]!.usd).toBeCloseTo(read.usd, 12);
    expect(read.usd).toBeCloseTo(estimateIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture)).usd, 15);
    // Both events share one local day: dailyTokens keys on input+output only.
    expect(read.dailyTokens).toEqual({ "2026-09-02": 1750 });
    expect(read.firstMs).toBe(Date.parse("2026-09-02T03:00:01.000Z"));
    expect(read.lastMs).toBe(Date.parse("2026-09-02T03:00:01.000Z"));
  });

  test("two models produce two entries; untimed records still count but never widen the span", () => {
    const untimed = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } },
    });
    const otherModel = [
      JSON.stringify({ timestamp: "2026-09-03T03:00:00.000Z", type: "turn_context", payload: { model: "openai.gpt-5.6-luna" } }),
      JSON.stringify({
        timestamp: "2026-09-03T03:00:01.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
      }),
    ].join("\n");
    const fixture: FsFixture = {
      dirs: ["/id/sessions"],
      files: {
        "/id/sessions/a.jsonl": { text: untimed, mtimeMs: MONTH_START.getTime() + 1 },
        "/id/sessions/b.jsonl": { text: otherModel, mtimeMs: MONTH_START.getTime() + 1 },
      },
    };
    const read = readIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture));
    expect(read.messages).toBe(2);
    expect(read.models.map((m) => m.model).sort()).toEqual(["openai.gpt-5.6-luna", "unknown"]);
    expect(read.firstMs).toBe(Date.parse("2026-09-03T03:00:01.000Z"));
    expect(read.lastMs).toBe(read.firstMs);
    expect(Object.keys(read.dailyTokens)).toEqual(["2026-09-03"]);
  });

  test("readerless tools and unreadable roots return zeroed token fields with the guard's exact notes", () => {
    const readerless = readIdentityLocalSpend("kimi", "/id", MONTH_START, fixtureDeps({ dirs: [], files: {} }));
    expect(readerless.notes).toEqual(['no local session reader for tool "kimi"']);
    expect(readerless.messages).toBe(0);
    expect(readerless.models).toEqual([]);
    expect(readerless.dailyTokens).toEqual({});
    const empty = readIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps({ dirs: [], files: {} }));
    expect(empty.messages).toBe(0);
    expect(empty.notes).toEqual([]);
    expect(empty.firstMs).toBeUndefined();
  });
});

/** The async twin's fixtures: a REAL on-disk codex sessions tree (so the
 * default Bun-stream reader and async directory walk run end to end), with
 * fresh timestamps so the records land inside a now-based period. */
const tempTreeDirs: string[] = [];

async function makeCodexTree(fileCount = 2): Promise<{ configDir: string; periodStart: Date }> {
  const root = await mkdtemp(join(tmpdir(), "ais-local-spend-async-"));
  tempTreeDirs.push(root);
  const now = new Date();
  const day = join(root, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  await mkdir(day, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const lines = [
      JSON.stringify({ timestamp: new Date(Date.now() - 30_000).toISOString(), type: "turn_context", payload: { model: `openai.gpt-6-astra-${i}` } }),
      JSON.stringify({
        timestamp: new Date(Date.now() - 20_000).toISOString(),
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 900, output_tokens: 50 } } },
      }),
      "not json at all",
      JSON.stringify({
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 5 } } },
      }),
    ];
    // No trailing newline on the last file: the torn-final-line path must
    // behave exactly like the sync reader's split("\n").
    await writeFile(join(day, `rollout-${i}.jsonl`), lines.join("\n") + (i === fileCount - 1 ? "" : "\n"));
  }
  return { configDir: root, periodStart: new Date(Date.now() - 60_000) };
}

afterEach(async () => {
  await Promise.all(tempTreeDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Async twin of the sync FsFixture deps: same virtual tree, optionally
 * serving readTextChunks in fixed-size string chunks with a delay, so
 * chunk-boundary and yielding behaviour are deterministic. */
function asyncFixtureDeps(fixture: FsFixture, chunkSize?: number, chunkDelayMs = 0) {
  const sync = fixtureDeps(fixture);
  return {
    readdir: (path: string): Promise<string[]> => Promise.resolve(sync.readdir(path)),
    mtimeMs: (path: string): Promise<number> => Promise.resolve(sync.mtimeMs(path)),
    isDirectory: (path: string): Promise<boolean> => Promise.resolve(sync.isDirectory(path)),
    ...(chunkSize
      ? {
          readTextChunks: async function* (path: string): AsyncIterable<string> {
            const text = fixture.files[path]?.text ?? (() => { throw new Error(`missing ${path}`); })();
            for (let i = 0; i < text.length; i += chunkSize) {
              if (chunkDelayMs > 0) await Bun.sleep(chunkDelayMs);
              yield text.slice(i, i + chunkSize);
            }
          },
        }
      : {}),
  };
}

describe("readIdentityLocalSpendAsync", () => {
  test("matches the sync reader exactly on the same on-disk month-to-date tree (default chunked reader)", async () => {
    const { configDir, periodStart } = await makeCodexTree(3);
    const sync = readIdentityLocalSpend("codex", configDir, periodStart);
    const asyncRead = await readIdentityLocalSpendAsync("codex", configDir, periodStart);
    // Byte-identical output, not just close numbers: same records, order,
    // rollups, span.
    expect(JSON.stringify(asyncRead)).toBe(JSON.stringify(sync));
    expect(asyncRead.filesRead).toBe(3);
    expect(asyncRead.messages).toBe(6);
    expect(asyncRead.usd).toBeGreaterThan(0);
  });

  test("reconstructs lines from unaligned string chunks identically to the sync reader", async () => {
    const text = [
      JSON.stringify({ timestamp: "2026-09-02T03:00:00.000Z", type: "turn_context", payload: { model: "openai.gpt-6-astra" } }),
      JSON.stringify({
        timestamp: "2026-09-02T03:00:01.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 900, output_tokens: 50 } } },
      }),
      "garbage {torn",
      JSON.stringify({
        timestamp: "2026-09-02T03:00:02.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7, output_tokens: 1 } } },
      }),
    ].join("\n"); // no trailing newline: the EOF remainder must still be scanned
    const fixture: FsFixture = {
      dirs: ["/id/sessions"],
      files: { "/id/sessions/rollout.jsonl": { text, mtimeMs: MONTH_START.getTime() + 1000 } },
    };
    // 7-code-unit chunks: every line split mid-content, no whole line ever
    // delivered in one chunk.
    const asyncRead = await readIdentityLocalSpendAsync("codex", "/id", MONTH_START, asyncFixtureDeps(fixture, 7, 1));
    const sync = readIdentityLocalSpend("codex", "/id", MONTH_START, fixtureDeps(fixture));
    expect(JSON.stringify(asyncRead)).toBe(JSON.stringify(sync));
    expect(asyncRead.messages).toBe(2);
  });

  test("yields the event loop between chunks: a 1ms timer keeps firing during a slow read", async () => {
    const text = Array.from({ length: 5 }, () => `${codexLine("turn_context")}\n${codexLine("token_count")}`).join("\n");
    const fixture: FsFixture = {
      dirs: ["/id/sessions"],
      files: { "/id/sessions/rollout.jsonl": { text, mtimeMs: MONTH_START.getTime() + 1000 } },
    };
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      const read = await readIdentityLocalSpendAsync("codex", "/id", MONTH_START, asyncFixtureDeps(fixture, 64, 3));
      expect(read.messages).toBe(5);
    } finally {
      clearInterval(timer);
    }
    // 3ms of chunk delay each x ~15 chunks: a blocked loop would tick ZERO
    // times (the sync reader provably froze a 1ms timer for whole seconds).
    expect(ticks).toBeGreaterThan(10);
  });

  test("two concurrent reads overlap in wall time: total ~= max, never the sum", async () => {
    const text = Array.from({ length: 3 }, () => `${codexLine("turn_context")}\n${codexLine("token_count")}`).join("\n");
    const makeFixture = (name: string): FsFixture => ({
      dirs: ["/id/sessions"],
      files: { [`/id/sessions/${name}.jsonl`]: { text, mtimeMs: MONTH_START.getTime() + 1000 } },
    });
    const started: string[] = [];
    const run = async (name: string) => {
      started.push(name);
      await readIdentityLocalSpendAsync("codex", "/id", MONTH_START, asyncFixtureDeps(makeFixture(name), 128, 10));
    };
    const t0 = performance.now();
    await Promise.all([run("a"), run("b"), run("c")]);
    const wall = performance.now() - t0;
    // Three ~80ms reads (8 chunks x 10ms): concurrent ~= 80-100ms; a
    // serialised reader would need ~240ms.
    expect(wall).toBeLessThan(170);
    expect(started).toEqual(["a", "b", "c"]);
  });

  test("the default reader streams a large file in many chunks, never buffering it whole", async () => {
    const { configDir, periodStart } = await makeCodexTree(1);
    const big = join(configDir, "sessions", String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, "0"), String(new Date().getDate()).padStart(2, "0"), "big.jsonl");
    const line = `${JSON.stringify({
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } },
    })}\n`;
    await writeFile(big, line.repeat(20_000)); // ~6MB
    let chunks = 0;
    for await (const _chunk of fileTextChunks(big)) chunks += 1;
    expect(chunks).toBeGreaterThan(4);
    // And the chunked async read of the whole tree still equals the sync read.
    const sync = readIdentityLocalSpend("codex", configDir, periodStart);
    const asyncRead = await readIdentityLocalSpendAsync("codex", configDir, periodStart);
    expect(JSON.stringify(asyncRead)).toBe(JSON.stringify(sync));
    expect(asyncRead.messages).toBe(sync.messages);
  });
});
