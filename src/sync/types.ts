import type { ToolConfig } from "../identities/types.ts";

export interface SyncConfig {
  version: 2;
  remotes: string[];
}

export type SyncDirection = "pull" | "push" | "both";

export type SyncScope =
  | { kind: "all" }
  | {
      kind: "identity";
      cfg: ToolConfig;
      identityName: string;
      cwd?: string;
    };

export interface SyncRunOptions {
  direction?: SyncDirection;
  scope?: SyncScope;
  quiet?: boolean;
  waitForLock?: boolean;
  /** False for debounced in-session reconciliation; live SQLite is snapshotted only after the child exits. */
  includeDatabases?: boolean;
}

export interface SyncRunResult {
  remotes: string[];
  pulled: string[];
  pushed: string[];
  skipped: boolean;
}
