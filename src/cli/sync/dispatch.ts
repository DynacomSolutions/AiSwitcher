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
import { TOOL_CONFIGS } from "../identities/resolve-tool.ts";
import { mergeIncomingProfileTree, recoverProfileArchives } from "../../sync/tree-merge.ts";
import type { SyncScope } from "../../sync/types.ts";
import { removeSyntheticLegacyRegistryEntries } from "../../sync/registry.ts";
import { SYNC_TOOL_CONFIGS } from "../../sync/rsync.ts";
import { aisRemoteCacheDir } from "../../shared/ais-home.ts";

const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function snapshotRoot(kind: "sqlite-snapshots" | "sqlite-incoming" | "profile-incoming", id: string): string {
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
        throw new Error("AIS sync is already running; the 30-second wait for its lock expired.");
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
      await automaticSync({
        direction,
        scope,
        waitForLock: boolFlag(flags, "wait"),
        includeDatabases: !boolFlag(flags, "no-databases"),
      });
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
      const snapshotId = crypto.randomUUID();
      const root = snapshotRoot("sqlite-snapshots", snapshotId);
      const manifest = await createCrushSnapshotTree(root);
      console.log(JSON.stringify({ snapshotId, databases: manifest.databases }));
      return;
    }
    case "merge-zai-snapshot": {
      if (!host) throw new CliUsageError("Usage: ais sync merge-zai-snapshot <snapshot-id>");
      const root = snapshotRoot("sqlite-incoming", host);
      const manifest = await loadCrushSnapshotManifest(root);
      const merged = await mergeCrushSnapshotTree(manifest);
      console.log(JSON.stringify({ merged }));
      return;
    }
    case "merge-profile-snapshot": {
      if (!host) throw new CliUsageError("Usage: ais sync merge-profile-snapshot <snapshot-id>");
      const scope = scopeFromFlags(flags);
      if (!scope) throw new CliUsageError("A profile snapshot requires both --tool and --identity, or neither.");
      const root = snapshotRoot("profile-incoming", host);
      const merged = await mergeIncomingProfileTree(root, scope);
      await makeProfileHookConfigsPortable(scope);
      if (scope.kind === "all") await makeSharedHookScriptsPortable();
      await rm(root, { recursive: true, force: true });
      console.log(JSON.stringify(merged));
      return;
    }
    default:
      throw new CliUsageError(`Unknown "ais sync" action "${action}". Use list, add, remove, now, dedupe, or recover.`);
  }
}
