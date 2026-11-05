/**
 * Regenerates export.json and hourly.json in this directory from synthetic
 * Claude transcripts, using the AIS-patched Tokscale 4.20.0 binary for both
 * the native export and the `hourly` report, with one shared config dir.
 *
 *   bun test/fixtures/tokscale-native-daily/generate.ts <patched-tokscale> [pricing-cache-dir]
 *
 * pricing-cache-dir (optional) supplies Tokscale's pricing-*.json caches so
 * the run needs no network. The tree covers duplicate messages, the local
 * recovery overlay (request-archive rows without timestamps and daily
 * floors) and the America/New_York DST change on 1 November 2026. Undated
 * balances only come from Claude Desktop's IndexedDB store and are covered by
 * unit tests instead.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [binary, pricingCache] = process.argv.slice(2);
if (!binary) throw new Error("usage: generate.ts <patched-tokscale> [pricing-cache-dir]");
const fixtureDir = dirname(new URL(import.meta.url).pathname);
const root = mkdtempSync(join(tmpdir(), "tokscale-native-daily-"));
const home = join(root, "home");
const identity = join(root, "identity");
const config = join(root, "config");
const partitionId = "a".repeat(64);

let seed = 7;
const random = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
const models = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];

try {
  mkdirSync(home, { recursive: true });
  mkdirSync(join(config, "cache"), { recursive: true });
  if (pricingCache) {
    for (const name of readdirSync(pricingCache)) if (/^pricing-.*\.json$/.test(name)) copyFileSync(join(pricingCache, name), join(config, "cache", name));
  }
  writeFileSync(join(config, "settings.json"), JSON.stringify({ scanner: { opencodeDbPaths: [], extraScanPaths: {}, bucketTimezone: "America/New_York" } }));

  // 03:00 UTC on 1 November 2026 to 09:00 UTC: New York leaves EDT at 06:00 UTC.
  const start = Date.UTC(2026, 10, 1, 3, 0);
  const assistantLines: string[] = [];
  for (let p = 0; p < 2; p++) {
    const project = join(identity, "projects", `-work-project-${p}`);
    mkdirSync(project, { recursive: true });
    for (let s = 0; s < 2; s++) {
      const sessionId = `00000000-0000-4000-8000-00000000000${p * 2 + s}`;
      const lines: string[] = [];
      let at = start - (p + s) * 26 * 3_600_000;
      for (let i = 0; i < 12; i++) {
        at += (5 + random(55)) * 60_000;
        const timestamp = new Date(at).toISOString();
        lines.push(JSON.stringify({ type: "user", timestamp, sessionId, cwd: `/work/project-${p}`, message: { role: "user", content: "synthetic" } }));
        const assistant = JSON.stringify({
          type: "assistant", timestamp, sessionId, cwd: `/work/project-${p}`, requestId: `req_${p}_${s}_${i}`,
          message: {
            id: `msg_${p}_${s}_${i}`, model: models[random(3)], role: "assistant", content: [{ type: "text", text: "synthetic" }],
            usage: { input_tokens: 1 + random(5000), output_tokens: 1 + random(3000), cache_read_input_tokens: random(90000), cache_creation_input_tokens: random(9000) },
          },
        });
        lines.push(assistant);
        assistantLines.push(assistant);
        // A streamed message is logged more than once; Tokscale deduplicates it.
        if (i % 4 === 0) lines.push(assistant);
      }
      writeFileSync(join(project, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
    }
  }
  // A copied session repeats messages already counted elsewhere.
  writeFileSync(join(identity, "projects", "-work-project-1", "00000000-0000-4000-8000-000000000009.jsonl"), `${assistantLines.slice(0, 5).join("\n")}\n`);

  const tokens = (input: number, output: number) => ({ input, output, cache_read: 0, cache_write: 0, reasoning: 0 });
  const row = (fields: Record<string, unknown>) => ({
    client: "claude", model_id: "claude-sonnet-4-5", provider_id: "anthropic", workspace_key: null, workspace_label: null,
    cost: 0.5, message_count: 1, agent: null, ...fields,
  });
  writeFileSync(join(config, "recovered-usage-v1.json"), JSON.stringify({
    version: 1,
    home,
    messages: [
      row({ session_id: "recovered-a", dedup_key: "recovered-a-1", timestamp: 0, date: "2026-10-28", tokens: tokens(700, 70) }),
      row({ session_id: "recovered-a", dedup_key: "recovered-a-2", timestamp: Date.UTC(2026, 9, 28, 15, 10), date: "2026-10-28", tokens: tokens(800, 80) }),
    ],
    daily_floors: [
      row({ session_id: "floor", dedup_key: "floor-1", timestamp: 0, date: "2026-10-27", tokens: tokens(5000, 500), cost: 2 }),
      row({ session_id: "floor", dedup_key: "floor-2", timestamp: 0, date: "2026-10-28", tokens: tokens(90000, 9000), cost: 3 }),
    ],
  }));

  const env = {
    PATH: "/usr/bin:/bin", HOME: home, TZ: "UTC", CLAUDE_CONFIG_DIR: identity, TOKSCALE_EXTRA_DIRS: "", TOKSCALE_CONFIG_DIR: config,
  };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync([binary, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  const exportPath = join(root, "export.json");
  run(["--client", "claude", "--json", "--no-spinner"], {
    TOKSCALE_AIS_SOURCE_CONFIG_DIR: join(root, "no-source-config"), TOKSCALE_AIS_EXPORT_PATH: exportPath,
    TOKSCALE_AIS_PARTITION_ID: partitionId, TOKSCALE_AIS_STAT_ONLY_CACHE: "1",
  });
  const hourly = JSON.parse(run(["hourly", "--client", "claude", "--json", "--no-spinner"]));
  hourly.processingTimeMs = 0;
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  exported.generatedAt = "2026-11-06T00:00:00.000Z";
  writeFileSync(join(fixtureDir, "export.json"), `${JSON.stringify(exported, null, 1)}\n`);
  writeFileSync(join(fixtureDir, "hourly.json"), `${JSON.stringify(hourly, null, 1)}\n`);
  console.log(`messages=${exported.messages.length} hours=${hourly.entries.length}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
