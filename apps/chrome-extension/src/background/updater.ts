// Self-update. Chrome extensions cannot write their own files, so the AIS native helper (registered by `ais update`)
// checks the latest release and replaces the extension folder; the extension then reloads itself once no agent call runs.
import type { UpdateInfo } from "../shared/panel.ts";

export const HOST_NAME = "ais_browser_extension";
/** Automatic checks at most this often. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const AUTO_KEY = "autoUpdate";
const STATE_KEY = "updateState";

type HostReply = { ok: true; latest?: string; installed?: string; updated?: boolean } | { ok: false; error: string };

export interface UpdaterDeps {
  /** chrome.runtime.sendNativeMessage to the AIS helper. Rejects when the helper is not registered. */
  sendNative(msg: { type: "check" | "update" }): Promise<unknown>;
  /** Saves session state for the next instance, then chrome.runtime.reload(). */
  reload(): Promise<void>;
  /** The running version (manifest). */
  version: string;
  /** True when no agent call runs. */
  isIdle(): boolean;
  storage: { get(keys: string[]): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> };
  now?: () => number;
  /** Re-checks idleness while a reload waits; tests pass a fake. */
  later?: (fn: () => void, ms: number) => void;
}

const parse = (v: string): number[] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

export function isNewer(a: string | undefined, b: string): boolean {
  const x = a ? parse(a) : undefined;
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** The helper is missing (never registered) or not allowed for this extension id. */
const isHostMissing = (msg: string): boolean => /not found|forbidden|has exited|native messaging host/i.test(msg);

export class Updater {
  private state: Omit<UpdateInfo, "running" | "auto"> = {};
  private auto = true;
  private busy = false;
  private readonly now: () => number;
  private readonly later: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: UpdaterDeps) {
    this.now = deps.now ?? Date.now;
    this.later = deps.later ?? ((fn, ms) => { setTimeout(fn, ms); });
  }

  async load(): Promise<void> {
    const r = await this.deps.storage.get([AUTO_KEY, STATE_KEY]);
    this.auto = r[AUTO_KEY] !== false;
    const s = r[STATE_KEY] as UpdaterState | undefined;
    if (s && typeof s === "object") this.state = { ...(s.latest ? { latest: s.latest } : {}), ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}), ...(s.error ? { error: s.error } : {}), ...(s.hostMissing ? { hostMissing: true } : {}) };
  }

  info(): UpdateInfo {
    return { running: this.deps.version, auto: this.auto, ...this.state };
  }

  async setAuto(enabled: boolean): Promise<void> {
    this.auto = enabled;
    await this.deps.storage.set({ [AUTO_KEY]: enabled });
    if (enabled) await this.tick(true);
  }

  /** Alarm/startup hook: checks when due and, with auto-update on, installs a newer release. */
  async tick(force = false): Promise<void> {
    if (this.busy || this.state.updating || this.state.waitingForIdle) return;
    if (!force && this.state.checkedAt !== undefined && this.now() - this.state.checkedAt < CHECK_EVERY_MS) return;
    const latest = await this.check();
    if (this.auto && latest && isNewer(latest, this.deps.version)) await this.update();
  }

  /** Asks the helper for the latest release. Returns it, or undefined on failure (kept in the state for the panel). */
  async check(): Promise<string | undefined> {
    this.busy = true;
    try {
      const r = await this.call("check");
      if (!r) return undefined;
      this.state = { latest: r.latest, checkedAt: this.now() };
      // Files already newer on disk (for example `ais browser extension update`): only a reload is missing.
      if (r.installed && isNewer(r.installed, this.deps.version)) this.reloadWhenIdle();
      return r.latest;
    } finally {
      this.busy = false;
      await this.save();
    }
  }

  /** Replaces the extension folder with the latest release, then reloads once no agent call runs. */
  async update(): Promise<void> {
    if (this.state.updating || this.state.waitingForIdle) return;
    this.state = { ...this.state, updating: true };
    delete this.state.error;
    try {
      const r = await this.call("update");
      if (!r) return;
      this.state = { ...this.state, latest: r.latest, checkedAt: this.now() };
      if (r.installed && isNewer(r.installed, this.deps.version)) this.reloadWhenIdle();
    } finally {
      delete this.state.updating;
      await this.save();
    }
  }

  private reloadWhenIdle(): void {
    if (this.deps.isIdle()) {
      void this.deps.reload();
      return;
    }
    this.state = { ...this.state, waitingForIdle: true };
    this.later(() => { delete this.state.waitingForIdle; this.reloadWhenIdle(); }, 2_000);
  }

  private async call(type: "check" | "update"): Promise<Extract<HostReply, { ok: true }> | undefined> {
    let reply: HostReply;
    try {
      reply = (await this.deps.sendNative({ type })) as HostReply;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.state = { ...this.state, checkedAt: this.now(), ...(isHostMissing(msg) ? { hostMissing: true, error: undefined } : { error: msg }) };
      if (!isHostMissing(msg)) delete this.state.hostMissing;
      else delete this.state.error;
      return undefined;
    }
    if (!reply || typeof reply !== "object" || reply.ok !== true) {
      this.state = { ...this.state, checkedAt: this.now(), error: (reply as { error?: string } | undefined)?.error ?? "The updater gave no answer." };
      delete this.state.hostMissing;
      return undefined;
    }
    delete this.state.error;
    delete this.state.hostMissing;
    return reply;
  }

  private async save(): Promise<void> {
    const { latest, checkedAt, error, hostMissing } = this.state;
    await this.deps.storage.set({ [STATE_KEY]: { ...(latest ? { latest } : {}), ...(checkedAt ? { checkedAt } : {}), ...(error ? { error } : {}), ...(hostMissing ? { hostMissing } : {}) } });
  }
}

interface UpdaterState { latest?: string; checkedAt?: number; error?: string; hostMissing?: boolean }
