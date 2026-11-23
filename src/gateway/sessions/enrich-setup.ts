import type { SQL } from "bun";
import { sessionsEnrichConfigFromEnv } from "./enrich-config.ts";
import { SessionEnricher } from "./enrich.ts";
import { SessionsEnrichMetrics } from "./enrich-metrics.ts";
import { S3PartSource } from "./part-reader.ts";
import { SessionStore } from "./session-store.ts";

export interface SessionsEnrichSetup {
  enricher: SessionEnricher;
  /** Exposition lines for /metrics. */
  render: () => string[];
}

/**
 * Builds the enrichment loop from the environment, or returns undefined while it is off (the default) or its settings
 * are incomplete (a warning names the missing variable). `isLeader` is the gateway leader check.
 */
export function createSessionsEnrichment(opts: {
  env: Record<string, string | undefined>;
  sql: SQL;
  isLeader: () => boolean;
  warn?: (message: string) => void;
}): SessionsEnrichSetup | undefined {
  let cfg;
  try {
    cfg = sessionsEnrichConfigFromEnv(opts.env);
  } catch (err) {
    (opts.warn ?? console.warn)(`gateway: session enrichment stays off: ${(err as Error).message}`);
    return undefined;
  }
  if (!cfg) return undefined;
  const metrics = new SessionsEnrichMetrics();
  const enricher = new SessionEnricher({
    store: new SessionStore("", { sql: opts.sql }),
    source: new S3PartSource(cfg),
    identity: cfg.ageIdentity,
    isLeader: opts.isLeader,
    metrics,
    batchFiles: cfg.batchFiles,
    intervalMs: cfg.intervalMs,
    log: (m) => (opts.warn ?? console.warn)(`gateway: ${m}`),
  });
  return { enricher, render: () => metrics.render() };
}
