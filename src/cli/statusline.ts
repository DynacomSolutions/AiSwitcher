import { foldValuedFlags, parseArgs, stringFlag } from "./args.ts";
import { loadLastGood } from "./limits/claude-limits.ts";
import { loadOne } from "./identities/resolve-tool.ts";
import { TOOL_CONFIGS } from "./identities/resolve-tool.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aisCacheDir } from "../shared/ais-home.ts";
import type { Identity } from "../identities/types.ts";
import {
  bandRows,
  barWidth,
  labelPad,
  memberBlocks,
  memberCards,
  providerBlocks,
  resolveCurrent,
  rowSegments,
  snapshotName,
} from "../../mods/ais-usage/hooks/model.ts";
import type { BandRow, Resolved, Seg, Snapshot } from "../../mods/ais-usage/hooks/model.ts";
import type { LimitsEntry } from "../../mods/ais-usage/types";

const ESC = "\u001b[";
const paint = (code: number, s: string) => (s ? `${ESC}${code}m${s}${ESC}0m` : "");
const CODE = { red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, gray: 90, dim: 2 } as const;
const BLOCK = "█";
const BOLD = 1;
/** A snapshot older than this is from a dead session. */
const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

/** The mod's toggle snapshot for this identity, or undefined when missing, stale or malformed. */
function readSnapshot(cacheDir: string, configDir: string | undefined): Snapshot | undefined {
  try {
    const s = JSON.parse(readFileSync(join(cacheDir, "ais-usage", snapshotName(configDir)), "utf8")) as Snapshot;
    if (!Array.isArray(s.limits) || typeof s.updatedAt !== "number" || Date.now() - s.updatedAt > SNAPSHOT_MAX_AGE_MS) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/** The open section from the snapshot; falls back to the older boolean fields. */
const openOf = (s: Snapshot) => (s.open !== undefined ? s.open : s.othersOpen ? "others" : s.membersOpen ? "members" : null);

/** Expanded block of the one open section: a bold title per tool, then its rows or member cards, with a rule between tools and under the last (the rule above it is printed by the caller). */
function toggleLines(s: Snapshot, configDir: string | undefined, cols: number): string[] {
  const r = resolveCurrent(s.limits, configDir, s.status);
  const rule = paint(CODE.dim, "─".repeat(cols));
  const groups: string[][] = [];
  const open = openOf(s);
  if (open === "others") {
    for (const g of providerBlocks(s.limits, r)) {
      const width = barWidth(r, g.rows, cols);
      const pad = labelPad(r, g.rows);
      groups.push([paint(BOLD, g.tool), ...g.rows.map((row) => renderRow(r, row, width, pad))]);
    }
  } else if (open === "members" && r.kind === "pool") {
    for (const g of memberCards(memberBlocks(s.status, s.limits, r), cols)) groups.push(g.map(renderSegs));
  }
  if (!groups.length) return [];
  return [...groups.flatMap((g, i) => (i ? [rule, ...g] : g)), rule];
}

const renderSegs = (segs: Seg[]): string =>
  segs.map((g) => (g.bold ? paint(BOLD, g.text) : g.dim ? paint(CODE.dim, g.text) : g.color ? paint(CODE[g.color], g.text) : g.text)).join("");

/** One band row as an ANSI line; `width` is the bar width, `labelPad` the longest label (shorter ones are right-padded). */
export function renderRow(r: Resolved, row: BandRow, width: number, pad = 0): string {
  return renderSegs(rowSegments(r, row, width, pad));
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
        ...(last?.extraUsage ? { extraUsage: last.extraUsage } : {}),
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
      ? ["\u2800", paint(CODE.dim, `${paint(CODE.blue, BLOCK)} ${r.pool} > ${paint(CODE.cyan, BLOCK)} ${r.current}`)]
      : [];
    const width = barWidth(r, rows, cols);
    const pad = labelPad(r, rows);
    // The U+2800 (braille blank) spacer above the key is not whitespace on purpose: Claude Code drops whitespace-only status lines, and JS trim() strips even NBSP.
    const lines = [...head, ...rows.map((row) => renderRow(r, row, width, pad)), paint(CODE.dim, "─".repeat(cols))];
    // shortcut: the snapshot is per identity, not per session, so two sessions on one identity share toggles; upgrade if that bites.
    const snap = readSnapshot(deps.cacheDir ?? aisCacheDir(), env.CLAUDE_CONFIG_DIR);
    if (snap) {
      try { lines.push(...toggleLines(snap, env.CLAUDE_CONFIG_DIR, cols)); } catch { /* bad snapshot: main bars only */ }
    }
    return lines.join("\n") + "\n";
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
