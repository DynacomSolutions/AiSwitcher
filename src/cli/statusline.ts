import { foldValuedFlags, parseArgs, stringFlag } from "./args.ts";
import { loadLastGood } from "./limits/claude-limits.ts";
import { loadOne } from "./identities/resolve-tool.ts";
import { TOOL_CONFIGS } from "./identities/resolve-tool.ts";
import { aisCacheDir } from "../shared/ais-home.ts";
import type { Identity } from "../identities/types.ts";
import {
  bandRows,
  bar,
  pct,
  resolveCurrent,
  tone,
  twoToneBar,
} from "../../mods/ais-usage/hooks/model.ts";
import type { BandRow, Resolved } from "../../mods/ais-usage/hooks/model.ts";
import type { LimitsEntry } from "../../mods/ais-usage/types";

const ESC = "\u001b[";
const paint = (code: number, s: string) => (s ? `${ESC}${code}m${s}${ESC}0m` : "");
const CODE = { red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, gray: 90, dim: 2 } as const;
const BLOCK = "█";

/** Plain texts of one row: pool text, current text, label, and the non-bar tail (resets, reporting). */
function rowText(r: Resolved, row: BandRow) {
  const pool = row.pool;
  const left = pool?.pct === undefined ? undefined : Math.max(0, 100 - Math.round(pool.pct));
  const poolText = pool ? (pool.pct === undefined ? "pool n/a" : `pool ${pct(pool.pct)} used, ${left}% left`) : "";
  const curText = pool ? `${r.current} ${pct(row.active)}` : pct(row.active);
  const labelLen = pool ? poolText.length + 5 + curText.length : curText.length;
  const resets = row.resets ? `  resets ${row.resets}` : "";
  const reporting = pool && pool.reporting < pool.total ? ` (${pool.reporting}/${pool.total} reporting)` : "";
  return { pool, poolText, curText, labelLen, resets, reporting };
}

const NAME_COL = 8;
const MARGIN = 3; // safety so a row never wraps

/** Bar width shared by every row: the columns left after the longest row's non-bar text. */
export function barWidth(r: Resolved, rows: BandRow[], cols: number): number {
  const fixed = Math.max(...rows.map((row) => {
    const t = rowText(r, row);
    return NAME_COL + 2 + 1 + t.labelLen + t.resets.length + t.reporting.length;
  }));
  return Math.max(10, cols - MARGIN - fixed);
}

/** One band row as an ANSI line; `width` is the bar width, `labelPad` the longest label (shorter ones are right-padded). */
export function renderRow(r: Resolved, row: BandRow, width: number, labelPad = 0): string {
  const t = rowText(r, row);
  const pool = t.pool;
  const body = pool
    ? twoToneBar(row.active, pool.pct, width)
        .map((s) => paint({ active: CODE.cyan, pool: CODE.blue, empty: CODE.gray }[s.kind], BLOCK.repeat(s.len)))
        .join("")
    : paint(CODE[tone(row.active)], bar(row.active, width)[0]) + paint(CODE.gray, bar(row.active, width)[1]);
  const label = pool
    ? `${paint(CODE[tone(pool.pct ?? 0)], t.poolText)}  |  ${paint(CODE[tone(row.active)], t.curText)}`
    : paint(CODE[tone(row.active)], t.curText);
  const pad = " ".repeat(Math.max(0, labelPad - t.labelLen));
  const resets = t.resets ? paint(CODE.dim, t.resets) : "";
  const reporting = t.reporting ? paint(CODE.dim, t.reporting) : "";
  return `${row.name.padEnd(NAME_COL)}[${body}] ${label}${pad}${resets}${reporting}`;
}

export interface StatuslineDeps {
  /** Claude identities; default: the real registry. */
  identities?: () => Promise<Identity[]>;
  cacheDir?: string;
}

/** Cached claude limits (the files `ais limits` keeps), shaped like `ais limits --json` entries. */
async function cachedLimits(deps: StatuslineDeps): Promise<LimitsEntry[]> {
  const identities = await (deps.identities ?? (async () => (await loadOne(TOOL_CONFIGS.claude)).file.identities))();
  const cacheDir = deps.cacheDir ?? aisCacheDir();
  return Promise.all(
    identities.map(async (identity) => {
      const last = await loadLastGood(identity, cacheDir);
      return {
        toolName: "claude",
        identity: { name: identity.name, configDir: identity.configDir, swapPool: identity.swapPool },
        windows: last?.windows ?? [],
        status: last ? "cached" : "unavailable",
      } as LimitsEntry;
    }),
  );
}

/** Real stdin width, else the controlling terminal, else COLUMNS, else 80. */
const widthFrom = (input: any, env: Record<string, string | undefined>): number => {
  const w = [input?.viewport?.columns, input?.terminal?.columns, input?.terminal?.width, input?.columns, input?.width]
    .find((n) => typeof n === "number" && n > 0);
  if (w) return w;
  try {
    const r = Bun.spawnSync(["sh", "-c", "stty size < /dev/tty"], { stdout: "pipe", stderr: "ignore" });
    const c = Number(new TextDecoder().decode(r.stdout).trim().split(/\s+/)[1]);
    if (r.exitCode === 0 && c > 0) return c;
  } catch { /* no controlling terminal */ }
  return Number(env.COLUMNS) > 0 ? Number(env.COLUMNS) : 80;
};

/** The bar rows for `stdin` (statusLine JSON); "" on missing data or any error. */
export async function usageBars(stdin: string, env: Record<string, string | undefined>, deps: StatuslineDeps = {}): Promise<string> {
  try {
    let input: unknown;
    try { input = JSON.parse(stdin); } catch { /* width falls back to COLUMNS */ }
    const limits = await cachedLimits(deps);
    // No cached pool status exists: build one from the registry on every run (members, active, allowed),
    // so members added to a pool show up with no code or config change.
    const r = resolveCurrent(limits, env.CLAUDE_CONFIG_DIR, null);
    const sp = limits.find((l) => l.identity.name === r.pool && l.identity.swapPool)?.identity.swapPool;
    const status = r.kind === "pool" && r.pool
      ? { pool: r.pool, active: r.current ?? "", auto: !!sp?.auto, thresholdPercent: sp?.thresholdPercent ?? 95,
          accounts: (r.members ?? []).map((name) => ({ name, active: name === r.current, allowed: !sp?.disallowed?.includes(name) })) }
      : null;
    const rows = bandRows(r, status, limits);
    if (!rows.length) return "";
    const cols = widthFrom(input, env);
    const head = r.pool
      ? [paint(CODE.dim, `${paint(CODE.blue, BLOCK)} ${r.pool} > ${paint(CODE.cyan, BLOCK)} ${r.current}`)]
      : [];
    const width = barWidth(r, rows, cols);
    const labelPad = Math.max(...rows.map((row) => rowText(r, row).labelLen));
    return [...head, ...rows.map((row) => renderRow(r, row, width, labelPad))].join("\n") + "\n";
  } catch {
    return "";
  }
}

/** `ais statusline [--wrap <command>]`. Never throws, always exits 0. */
export async function runStatuslineCommand(argv: string[], deps: StatuslineDeps = {}): Promise<void> {
  try {
    const stdin = await Bun.stdin.text().catch(() => "");
    const wrap = stringFlag(parseArgs(foldValuedFlags(argv, ["wrap"])).flags, "wrap");
    let out = "";
    if (wrap) {
      try {
        const p = Bun.spawn(["bash", "-c", wrap], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "inherit" });
        out = await new Response(p.stdout).text();
        await p.exited;
      } catch { /* wrapped command failure never breaks the bars */ }
    }
    const bars = await usageBars(stdin, process.env, deps);
    process.stdout.write(out + (out && bars && !out.endsWith("\n") ? "\n" : "") + bars);
  } catch { /* a broken status line must stay silent */ }
}
