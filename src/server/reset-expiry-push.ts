import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolLimitResult } from "../cli/limits/types.ts";
import { consoleWebDir } from "./state.ts";
import { loadSubscriptions, sendToAll, type PushMessage, type SendResult } from "./web-push.ts";
import type { ScanResult } from "./scan-worker.ts";

/**
 * Push reminders for unspent manual resets before they expire: once when a
 * reset is 7 days from its end, again at 3 days, and a last time at 24 hours.
 * Sources are the same limits the console shows: Claude reset grants
 * (`manualReset.grants[].endsAt`, including the last list Anthropic sent) and
 * Codex reset credits (`manualReset.creditExpiries`). Swap pool rows mirror a
 * member's login and are skipped, so a member's grant is not announced twice.
 *
 * The check runs hourly in the daemon and only scans limits when at least one
 * browser has subscribed. Sent stages are kept in `reset-expiry-push.json`, so a
 * daemon restart never repeats a reminder. A reset first seen inside a later
 * stage (say 2 days left) gets that one reminder, not the earlier ones.
 */

export type ExpiryStage = "7d" | "3d" | "24h";

const DAY_MS = 24 * 3600 * 1000;
/** Most urgent first. */
const STAGES: { stage: ExpiryStage; withinMs: number }[] = [
  { stage: "24h", withinMs: DAY_MS },
  { stage: "3d", withinMs: 3 * DAY_MS },
  { stage: "7d", withinMs: 7 * DAY_MS },
];
const RANK: Record<ExpiryStage, number> = { "7d": 1, "3d": 2, "24h": 3 };

export const DEFAULT_RESET_PUSH_INTERVAL_MS = 3600 * 1000;
const FIRST_TICK_DELAY_MS = 60_000;

export interface ExpiringReset {
  /** Stable per account and grant: provider, identity, grant id and end time. */
  key: string;
  provider: string;
  identity: string;
  label: string;
  /** Resets left on the grant, when the provider says (Claude). */
  resetsLeft?: number;
  endsAt: string;
}

const PROVIDER_NAME: Record<string, string> = { anthropic: "Claude", openai: "Codex" };

function providerName(result: Pick<ToolLimitResult, "provider" | "toolName">): string {
  return PROVIDER_NAME[result.provider] ?? (result.toolName === "claude" ? "Claude" : result.toolName === "codex" ? "Codex" : result.provider);
}

/** Every unspent reset with a known end in the future, from one limits payload. */
export function expiringResets(results: ToolLimitResult[], now: number): ExpiringReset[] {
  const out = new Map<string, ExpiringReset>();
  for (const r of results) {
    if (r.identity?.swapPool !== undefined || r.identity?.retired) continue;
    const reset = r.manualReset;
    if (!reset) continue;
    const identity = r.identity.name;
    const add = (id: string, label: string | undefined, endsAt: string | undefined, resetsLeft?: number) => {
      if (!endsAt) return;
      const ms = Date.parse(endsAt);
      if (!Number.isFinite(ms) || ms <= now) return;
      const key = `${r.provider}|${identity}|${id}|${endsAt}`;
      out.set(key, { key, provider: providerName(r), identity, label: label ?? id, ...(resetsLeft !== undefined ? { resetsLeft } : {}), endsAt });
    };
    for (const g of reset.grants ?? []) if (g.resetsLeft > 0) add(g.id, g.label, g.endsAt, g.resetsLeft);
    for (const c of reset.creditExpiries ?? []) add(c.id, c.label, c.endsAt);
  }
  return [...out.values()];
}

export function stageFor(endsAt: string, now: number): ExpiryStage | undefined {
  const left = Date.parse(endsAt) - now;
  if (!(left > 0)) return undefined;
  // STAGES is most urgent first: the first window that holds the time left wins.
  return STAGES.find((s) => left <= s.withinMs)?.stage;
}

function timeLeft(endsAt: string, now: number): string {
  const hours = Math.max(1, Math.round((Date.parse(endsAt) - now) / 3600_000));
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function messageFor(item: ExpiringReset, now: number, timeZone?: string): PushMessage {
  const when = new Date(item.endsAt).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  const left = item.resetsLeft !== undefined && item.resetsLeft > 1 ? ` (${item.resetsLeft} left)` : "";
  return {
    title: `${item.provider} reset expires in ${timeLeft(item.endsAt, now)}`,
    body: `${item.identity}: ${item.label}${left}. Use it before ${when}.`,
    tag: `reset-expiry:${item.key}`,
    url: "/limits",
  };
}

interface SentState {
  /** key -> most urgent stage already sent. */
  sent: Record<string, ExpiryStage>;
}

export function resetPushStatePath(dir: string = consoleWebDir()): string {
  return join(dir, "reset-expiry-push.json");
}

async function loadState(path: string): Promise<SentState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SentState>;
    return { sent: parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {} };
  } catch {
    return { sent: {} };
  }
}

async function saveState(path: string, state: SentState): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.partial`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export interface ResetExpiryNotifierDeps {
  intervalMs?: number;
  /** The daemon's limits scan (shared cache with /api/limits). */
  scanLimits: () => Promise<ScanResult<{ results?: ToolLimitResult[] }>>;
  send?: (message: PushMessage) => Promise<SendResult>;
  hasSubscribers?: () => Promise<boolean>;
  statePath?: string;
  now?: () => number;
  log?: (message: string) => void;
  /** IANA zone for the time in the message; defaults to AIS_PUSH_TIMEZONE, then TZ. */
  timeZone?: string;
}

export interface ResetExpiryStatus {
  running: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  lastSent: number;
}

export class ResetExpiryNotifier {
  private timer: ReturnType<typeof setInterval> | undefined;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private lastCheckAt: string | null = null;
  private lastError: string | null = null;
  private lastSent = 0;

  constructor(private readonly deps: ResetExpiryNotifierDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? DEFAULT_RESET_PUSH_INTERVAL_MS;
    this.bootTimer = setTimeout(() => void this.tick(), Math.min(FIRST_TICK_DELAY_MS, interval));
    this.bootTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.bootTimer = undefined;
  }

  status(): ResetExpiryStatus {
    return { running: this.timer !== undefined, lastCheckAt: this.lastCheckAt, lastError: this.lastError, lastSent: this.lastSent };
  }

  /** One check: scan limits, send each reset's newly reached stage, record it. Never throws. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const hasSubscribers = this.deps.hasSubscribers ?? (async () => (await loadSubscriptions()).length > 0);
      if (!(await hasSubscribers())) return 0;
      const scan = await this.deps.scanLimits();
      if (!scan.ok) throw new Error(scan.error ?? "limits scan failed");
      const now = (this.deps.now ?? Date.now)();
      const path = this.deps.statePath ?? resetPushStatePath();
      const state = await loadState(path);
      const items = expiringResets(scan.payload?.results ?? [], now);
      const send = this.deps.send ?? ((m: PushMessage) => sendToAll(m, { log: this.log }));
      const timeZone = this.deps.timeZone ?? (process.env.AIS_PUSH_TIMEZONE?.trim() || undefined);
      let sent = 0;
      for (const item of items) {
        const stage = stageFor(item.endsAt, now);
        if (!stage) continue;
        const prev = state.sent[item.key];
        if (prev && RANK[prev] >= RANK[stage]) continue;
        const result = await send(messageFor(item, now, timeZone));
        // Recorded only once a browser took it, so a push service outage retries next hour.
        if (result.sent > 0) {
          state.sent[item.key] = stage;
          sent++;
        }
      }
      // Forget resets that have ended.
      for (const key of Object.keys(state.sent)) {
        const endsAt = key.slice(key.lastIndexOf("|") + 1);
        if (!(Date.parse(endsAt) > now)) delete state.sent[key];
      }
      await saveState(path, state);
      this.lastSent = sent;
      this.lastError = null;
      if (sent > 0) this.log(`reset-expiry push: sent ${sent} reminder${sent === 1 ? "" : "s"}`);
      return sent;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`reset-expiry push: ${this.lastError}`);
      return 0;
    } finally {
      this.lastCheckAt = new Date((this.deps.now ?? Date.now)()).toISOString();
      this.ticking = false;
    }
  }

  private log = (message: string): void => {
    (this.deps.log ?? ((m: string) => console.error(m)))(message);
  };
}
