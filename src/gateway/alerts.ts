import type { LedgerBuffer } from "./ledger-buffer.ts";

export type AlertKind = "refresh-failed" | "ledger-drop";

export interface OwnerAlert {
  kind: AlertKind;
  /** Deduplication key: `<provider>/<identity>` for a login, `ledger` for the buffer. */
  key: string;
  /** Plain text; never carries tokens, paths or provider response text. */
  message: string;
}

export type Notifier = (alert: OwnerAlert) => void | Promise<void>;

/**
 * AIS has no push channel: its operator notifications (spend guard) are loud
 * lines on the daemon's stderr, which the host service captures. The gateway
 * does the same, with a stable prefix so a log rule can match it.
 */
export const stderrNotifier: Notifier = (a) => {
  console.error(`[gateway-alert] ${a.kind} ${a.key}: ${a.message}`);
};

export interface Alerter {
  /** Notifies once; further raises for the same kind and key are ignored until `recover`. */
  raise(kind: AlertKind, key: string, message: string): void;
  recover(kind: AlertKind, key: string): void;
}

export function createAlerter(notify: Notifier): Alerter {
  const open = new Set<string>();
  return {
    raise(kind, key, message) {
      const id = `${kind}\u0000${key}`;
      if (open.has(id)) return;
      open.add(id);
      // A broken notifier must never reach the request path.
      try {
        void Promise.resolve(notify({ kind, key, message })).catch(() => undefined);
      } catch {
        // ignored
      }
    },
    recover(kind, key) {
      open.delete(`${kind}\u0000${key}`);
    },
  };
}

/**
 * Returns a check to run on a timer: raises one alert when the ledger has
 * dropped rows since the last look, and recovers once the buffer is empty with
 * no further drops.
 */
export function watchLedger(ledger: Pick<LedgerBuffer, "dropped" | "depth">, alerter: Alerter): () => void {
  let lastDropped = ledger.dropped;
  return () => {
    const dropped = ledger.dropped;
    if (dropped > lastDropped) {
      alerter.raise("ledger-drop", "ledger", `usage ledger dropped ${dropped} row(s) in total; the database is unreachable or rejecting rows`);
    } else if (ledger.depth === 0) {
      alerter.recover("ledger-drop", "ledger");
    }
    lastDropped = dropped;
  };
}
