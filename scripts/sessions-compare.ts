#!/usr/bin/env bun
/**
 * Read-only: compares the old file scan with the database tree for one host and lists every difference.
 *
 *   bun run scripts/sessions-compare.ts --node <node> --config-dir <dir> [--config-dir <dir> ...] [--days 30]
 *        [--rows <rows.json>] [--json] [--out <file>]
 *   bun run scripts/sessions-compare.ts --print-sql      the SELECT that exports the rows of a host
 *
 * The files side scans each `--config-dir` (a folder that holds `projects/` and `sessions/`) with the console readers.
 * The database side reads the stored rows of `--node` from the gateway database (`AIS_GATEWAY_STORE_DATABASE_URL`, one
 * SELECT, nothing is written), or from `--rows`, a JSON array of result rows of the printed SELECT (for a run where the
 * database is only reachable from inside the cluster). Exit code 0: at least 99.9% of the nodes both sides hold are equal and every difference
 * is explained. Exit code 1: otherwise. Exit code 2: bad arguments.
 */
import { SQL } from "bun";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DB_SESSION_TOOLS } from "../src/server/sessions-db/db-source.ts";
import { compareHost, formatHostReport, HOST_ROWS_SQL, rowOfRaw } from "../src/server/sessions-db/compare-host.ts";

const MIN_SHARE = 0.999;

function parse(argv: string[]): { node?: string; dirs: string[]; days: number; rows?: string; json: boolean; out?: string; printSql: boolean } | undefined {
  const a = { dirs: [] as string[], days: 30, json: false, printSql: false } as ReturnType<typeof parse> & object;
  const need = (i: number): string | undefined => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--json") a.json = true;
    else if (k === "--print-sql") a.printSql = true;
    else if (k === "--node") a.node = need(i++)!;
    else if (k === "--config-dir") a.dirs.push(resolve(need(i++)!));
    else if (k === "--days") a.days = Number(need(i++));
    else if (k === "--rows") a.rows = resolve(need(i++)!);
    else if (k === "--out") a.out = resolve(need(i++)!);
    else return undefined;
  }
  if (!Number.isFinite(a.days) || a.days <= 0) return undefined;
  return a;
}

const args = parse(process.argv.slice(2));
if (!args || (!args.printSql && (!args.node || args.dirs.length === 0))) {
  console.error("usage: bun run scripts/sessions-compare.ts --node <node> --config-dir <dir> [--config-dir <dir> ...] [--days 30] [--rows <rows.json>] [--json] [--out <file>]\n       bun run scripts/sessions-compare.ts --print-sql");
  process.exit(2);
}
if (args.printSql) {
  console.log(HOST_ROWS_SQL.trim().replaceAll("$1", "'<node>'").replaceAll("$2::text[]", "ARRAY['claude','codex']"));
  process.exit(0);
}

let raw: Record<string, unknown>[];
if (args.rows) {
  raw = JSON.parse(await Bun.file(args.rows).text());
} else {
  const url = process.env.AIS_GATEWAY_STORE_DATABASE_URL;
  if (!url) {
    console.error("AIS_GATEWAY_STORE_DATABASE_URL is not set; use --rows with an export of the printed SELECT");
    process.exit(2);
  }
  const sql = new SQL(url);
  try {
    raw = (await sql.unsafe(HOST_ROWS_SQL, [args.node!, [...DB_SESSION_TOOLS]])) as Record<string, unknown>[];
  } finally {
    await sql.close();
  }
}
const rows = raw.map(rowOfRaw).filter((r) => args.rows === undefined || r.node === args.node);
const report = await compareHost({ node: args.node!, rows, configDirs: args.dirs, days: args.days });
const text = args.json ? JSON.stringify(report, null, 2) : formatHostReport(report);
if (args.out) await writeFile(args.out, `${text}\n`);
console.log(text);
process.exit(report.matchedShare >= MIN_SHARE && report.unexplained === 0 ? 0 : 1);
