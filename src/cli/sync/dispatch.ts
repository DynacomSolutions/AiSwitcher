import type { ParsedArgs } from "../args.ts";
import { boolFlag, stringFlag } from "../args.ts";
import { green } from "../colors.ts";
import { CliUsageError } from "../errors.ts";
import { addRemote, loadSyncConfig, removeRemote, saveSyncConfig, syncConfigPath } from "../../sync/config.ts";
import { deduplicateUsageData } from "../../sync/dedupe.ts";
import { syncConfiguredProfiles } from "../../sync/service.ts";
import { makeProfileHookConfigsPortable, makeSharedHookScriptsPortable } from "../../sync/portable-config.ts";
import {
  createCrushSnapshotTree,
  loadCrushSnapshotManifest,
  mergeCrushSnapshotTree,
} from "../../sync/sqlite-merge.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { automaticSync } from "../../sync/service.ts";
import { scheduleAutomaticSync } from "../../sync/auto-schedule.ts";
import { lowerProcessPriority } from "../../sync/low-priority.ts";
import { ioPhase, ioSnapshot, stagedSummary } from "../../sync/io-trace.ts";
import { pruneStaging } from "../../sync/staging.ts";
import { listHistories, planTails, TAIL_MIN_BYTES, type HistoryManifest } from "../../sync/tail-sync.ts";
import { TOOL_CONFIGS } from "../identities/resolve-tool.ts";
import { crushFingerprint } from "../../sync/steady-state.ts";
import { mergeIncomingProfileTree, recoverProfileArchives, withProfileMergeLock } from "../../sync/tree-merge.ts";
import type { SyncScope } from "../../sync/types.ts";
import { removeSyntheticLegacyRegistryEntries } from "../../sync/registry.ts";
import { SYNC_TOOL_CONFIGS } from "../../sync/rsync.ts";
import { aisRemoteCacheDir } from "../../shared/ais-home.ts";

const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function snapshotRoot(kind: "sqlite-snapshots" | "sqlite-incoming" | "profile-incoming" | "tail-incoming" | "tail-outgoing", id: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(id)) throw new CliUsageError(`Invalid sync snapshot id "${id}".`);
  return join(aisRemoteCacheDir(homedir()), kind, id);
}

function scopeFromFlags(flags: ParsedArgs["flags"]): SyncScope | undefined {
  const toolName = stringFlag(flags, "tool");
  const identityName = stringFlag(flags, "identity");
  const cwd = stringFlag(flags, "cwd");
  const cfg = toolName ? TOOL_CONFIGS[toolName as keyof typeof TOOL_CONFIGS] : undefined;
  if ((toolName && !cfg) || Boolean(toolName) !== Boolean(identityName)) return undefined;
  return cfg && identityName ? { kind: "identity", cfg, identityName, cwd } : { kind: "all" };
}

export async function runSyncCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const [action, host] = positionals;
  switch (action ?? "list") {
    case "list": {
      const config = await loadSyncConfig();
      if (config.remotes.length === 0) {
        console.log(`No SSH sync remotes configured (${syncConfigPath()}).`);
        return;
      }
      console.log(config.remotes.join("\n"));
      return;
    }
    case "add": {
      if (!host) throw new CliUsageError("Usage: ais sync add <ssh-host>");
      const config = await loadSyncConfig();
      const changed = addRemote(config, host);
      if (changed) await saveSyncConfig(config);
      console.log(`${green("✔")} ${changed ? "Added" : "Already configured:"} SSH sync remote ${host}.`);
      return;
    }
    case "remove": {
      if (!host) throw new CliUsageError("Usage: ais sync remove <ssh-host>");
      const config = await loadSyncConfig();
      if (!removeRemote(config, host)) throw new CliUsageError(`SSH sync remote "${host}" is not configured.`);
      await saveSyncConfig(config);
      console.log(`${green("✔")} Removed SSH sync remote ${host}.`);
      return;
    }
    case "now": {
      if (boolFlag(flags, "pull-only") && boolFlag(flags, "push-only")) {
        throw new CliUsageError("Use only one of --pull-only or --push-only.");
      }
      const direction = boolFlag(flags, "pull-only") ? "pull" : boolFlag(flags, "push-only") ? "push" : "both";
      const scope = scopeFromFlags(flags);
      if (!scope) throw new CliUsageError("Use both --tool and --identity to scope a sync, or neither.");
      const result = await syncConfiguredProfiles({
        direction,
        scope,
        waitForLock: true,
        includeDatabases: !boolFlag(flags, "no-databases"),
      });
      if (result.remotes.length === 0) throw new CliUsageError('No SSH sync remotes configured. Run "ais sync add <host>" first.');
      if (result.skipped) {
        throw new Error("AIS sync is still held by another running sync after the 10-minute wait; nothing was synced. Retry once it finishes.");
      }
      const actions = [
        ...(result.pulled.length ? [`pulled from ${result.pulled.join(", ")}`] : []),
        ...(result.pushed.length ? [`pushed to ${result.pushed.join(", ")}`] : []),
      ];
      console.log(`${green("✔")} AIS profiles synced: ${actions.join("; ")}.`);
      return;
    }
    // Internal detached-worker entrypoint. Automatic callers deliberately
    // discard output and errors; unlike `sync now`, this never makes a user
    // wait for SSH and never turns an unavailable host into a command error.
    case "background": {
      if (boolFlag(flags, "pull-only") && boolFlag(flags, "push-only")) return;
      const direction = boolFlag(flags, "pull-only") ? "pull" : boolFlag(flags, "push-only") ? "push" : "both";
      const scope = scopeFromFlags(flags);
      if (!scope) return;
      lowerProcessPriority();
      const minIntervalMinutes = await loadSyncConfig().then((c) => c.minIntervalMinutes, () => undefined);
      await scheduleAutomaticSync(
        {
          direction,
          scope,
          waitForLock: boolFlag(flags, "wait"),
          includeDatabases: !boolFlag(flags, "no-databases"),
        },
        { minIntervalMinutes, run: automaticSync },
      );
      return;
    }
    case "dedupe": {
      const dryRun = boolFlag(flags, "dry-run");
      if (!dryRun) {
        await makeProfileHookConfigsPortable();
        await makeSharedHookScriptsPortable();
      }
      const result = await deduplicateUsageData({ dryRun });
      if (boolFlag(flags, "json")) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `${green("✔")} ${dryRun ? "Would deduplicate" : "Deduplicated"} ${result.duplicateSessions} session(s); ` +
          `${result.divergentSessions} divergent, ${result.archivedPaths} redundant path(s)` +
          `${result.archiveRoot ? ` archived under ${result.archiveRoot}` : ""}.`,
      );
      return;
    }
    case "recover": {
      const dryRun = boolFlag(flags, "dry-run");
      const result = await recoverProfileArchives({ dryRun });
      if (boolFlag(flags, "json")) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `${green("✔")} ${dryRun ? "Would recover" : "Recovered"} ${result.mergedJsonlFiles} JSONL history file(s) ` +
          `and ${result.copiedFiles} missing sidecar file(s) from ${result.archiveRoots} retained archive(s).`,
      );
      return;
    }
    case "clean-legacy-identities": {
      const removed = await removeSyntheticLegacyRegistryEntries(SYNC_TOOL_CONFIGS);
      console.log(JSON.stringify({ removed }, null, 2));
      return;
    }
    // Internal SSH protocol used by sync/service.ts. Snapshots are created
    // and merged through SQLite itself; rsync never touches a live database.
    case "snapshot-zai": {
      // The token is taken before the snapshot, so a concurrent write only causes a redundant later run.
      const token = await ioPhase("snapshot-fingerprint", () => crushFingerprint(homedir()));
      // No token means no database: an empty snapshot would only cost a copy, a pull and a drop each run.
      if (!token || stringFlag(flags, "if-changed") === token) {
        console.log(JSON.stringify({ unchanged: true, token, io: ioSnapshot() }));
        return;
      }
      const snapshotId = crypto.randomUUID();
      const root = snapshotRoot("sqlite-snapshots", snapshotId);
      const manifest = await ioPhase("snapshot-create", () => createCrushSnapshotTree(root));
      console.log(JSON.stringify({ snapshotId, databases: manifest.databases, token, io: ioSnapshot() }));
      return;
    }
    case "drop-zai-snapshot": {
      if (!host) throw new CliUsageError("Usage: ais sync drop-zai-snapshot <snapshot-id>");
      await rm(snapshotRoot("sqlite-snapshots", host), { recursive: true, force: true });
      return;
    }
    case "merge-zai-snapshot": {
      if (!host) throw new CliUsageError("Usage: ais sync merge-zai-snapshot <snapshot-id>");
      const root = snapshotRoot("sqlite-incoming", host);
      const manifest = await loadCrushSnapshotManifest(root);
      const merged = await ioPhase("crush-merge", () => mergeCrushSnapshotTree(manifest));
      await rm(root, { recursive: true, force: true });
      console.log(JSON.stringify({ merged, token: await crushFingerprint(homedir()), io: ioSnapshot() }));
      return;
    }
    // Tail-only exchange of append-only histories (see sync/tail-sync.ts).
    case "tail-manifest": {
      const scope = scopeFromFlags(flags);
      if (!scope) throw new CliUsageError("A tail manifest requires both --tool and --identity, or neither.");
      const manifest = await ioPhase("tail-manifest", () => listHistories(homedir(), scope, undefined, TAIL_MIN_BYTES));
      console.log(JSON.stringify({ manifest, io: ioSnapshot() }));
      return;
    }
    case "tail-plan": {
      if (!host) throw new CliUsageError("Usage: ais sync tail-plan <id> (receiver manifest on stdin)");
      const scope = scopeFromFlags(flags);
      if (!scope) throw new CliUsageError("A tail plan requires both --tool and --identity, or neither.");
      const manifest = JSON.parse(await Bun.stdin.text()) as HistoryManifest;
      const plan = await ioPhase("tail-plan", () => planTails(homedir(), scope, manifest, snapshotRoot("tail-outgoing", host)));
      console.log(JSON.stringify({ planned: Object.keys(plan).length, io: ioSnapshot() }));
      return;
    }
    case "drop-tail-plan": {
      if (!host) throw new CliUsageError("Usage: ais sync drop-tail-plan <id>");
      await rm(snapshotRoot("tail-outgoing", host), { recursive: true, force: true });
      return;
    }
    case "merge-profile-snapshot": {
      if (!host) throw new CliUsageError("Usage: ais sync merge-profile-snapshot <snapshot-id>");
      const scope = scopeFromFlags(flags);
      if (!scope) throw new CliUsageError("A profile snapshot requires both --tool and --identity, or neither.");
      const root = snapshotRoot("profile-incoming", host);
      const tailsId = stringFlag(flags, "tails");
      const tailsDir = tailsId ? snapshotRoot("tail-incoming", tailsId) : undefined;
      await ioPhase("prune-staging", () => pruneStaging({ keep: host }));
      const merged = await withProfileMergeLock(homedir(), async (lock) => {
        const result = await ioPhase("profile-merge", () => mergeIncomingProfileTree(root, scope, { lock, tailsDir }), () => stagedSummary(root));
        await ioPhase("portable", async () => {
          await makeProfileHookConfigsPortable(scope);
          if (scope.kind === "all") await makeSharedHookScriptsPortable();
        });
        await rm(root, { recursive: true, force: true });
        if (tailsDir) await rm(tailsDir, { recursive: true, force: true });
        return result;
      });
      console.log(JSON.stringify({ ...merged, io: ioSnapshot() }));
      return;
    }
    default:
      throw new CliUsageError(`Unknown "ais sync" action "${action}". Use list, add, remove, now, dedupe, or recover.`);
  }
}
