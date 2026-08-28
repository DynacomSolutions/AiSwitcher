import type { ToolConfig } from "../identities/types.ts";
import { basename, join } from "node:path";
import { resolveIdentity } from "../identities/resolve.ts";
import { PromptCancelledError } from "../identities/errors.ts";
import { parseCliArgs, resolveNestedIdentity } from "./cli-args.ts";
import { resolveRealBinary } from "./resolve-binary.ts";
import { IDENTITY_SESSION_MARKER, spawnReal } from "./exec.ts";
import { launchDesktopApp } from "./launch-desktop.ts";
import { launchThenStartBackgroundSync, startBackgroundProfileSync } from "../sync/background.ts";
import { startProfileSyncWatcher } from "../sync/watch.ts";
import { migrateLegacyAisHome } from "./migrate-ais-home.ts";
import { codexPlatformArgs } from "./codex-platform-config.ts";
import { projectGlobalMemoryForLaunch } from "./global-memory.ts";

export async function runWrapper(
  cfg: ToolConfig,
  appName: "Claude" | "Codex" | "Grok" | "Kimi" | "Crush" | "Pi" | "OpenCode",
  beforeLaunch?: (configDir: string) => Promise<unknown>,
): Promise<void> {
  try {
    // Self-healing, idempotent, and must run before resolveRealBinary()
    // (which now defaults to looking under ~/.ais/npm) or any sync/background
    // work (which now defaults to ~/.ais/remote-cache and ~/.ais/config) —
    // see migrate-ais-home.ts. Never throws.
    await migrateLegacyAisHome();
    const parsed = parseCliArgs(cfg.toolName, process.argv.slice(2));
    const parentIdentity = process.env[IDENTITY_SESSION_MARKER];

    // A nested launch with no --id auto-inherits the parent session's
    // identity (see resolveNestedIdentity) — only an explicit, DIFFERENT
    // --id is rejected as cross-identity pollution.
    const identityFlag = resolveNestedIdentity(
      cfg.toolName,
      parentIdentity,
      parsed.identityFlag,
    );

    const resolved = await resolveIdentity(cfg, {
      explicitIdentityFlag: identityFlag,
      cwd: process.cwd(),
      env: process.env,
      nonInteractiveHint: parsed.nonInteractiveHint,
    });

    await beforeLaunch?.(resolved.configDirValue);

    if (parsed.desktopFlag) {
      const launch = () => launchDesktopApp(appName, cfg.envVarName, resolved.configDirValue, cfg.extraEnvVarNames);
      if (parentIdentity) launch();
      else launchThenStartBackgroundSync(launch);
      console.error(
        `${cfg.toolName}: launched ${appName}.app directly with ${cfg.envVarName}=${resolved.configDirValue} ` +
          `(unverified whether the app actually respects this — see AGENTS.md).`,
      );
      process.exit(0);
    }

    const realBinary = resolveRealBinary(cfg.realBinaryName);
    const activeIdentity = resolved.identity?.name ?? basename(resolved.configDirValue.replace(/\/$/, ""));
    const extraEnv = Object.fromEntries(
      (cfg.extraEnvVarNames ?? []).map(({ name, subdir }) => [
        name,
        subdir ? join(resolved.configDirValue, subdir) : resolved.configDirValue,
      ]),
    );
    const watcher = resolved.identity
      ? startProfileSyncWatcher(
          cfg,
          resolved.identity.name,
          resolved.identity.configDir,
          process.cwd(),
        )
      : undefined;
    const platformArgs = cfg.toolName === "codex"
      ? codexPlatformArgs(resolved.configDirValue, parsed.cleanedArgv)
      : parsed.cleanedArgv;
    const memoryProjection = await projectGlobalMemoryForLaunch(
      cfg,
      resolved.configDirValue,
      platformArgs,
    );
    const launch = () =>
      spawnReal(realBinary, memoryProjection.argv, {
        [cfg.envVarName]: resolved.configDirValue,
        ...extraEnv,
        ...memoryProjection.env,
        [IDENTITY_SESSION_MARKER]: activeIdentity,
      });
    // The real agent is spawned before the detached sync worker. Nothing in
    // the automatic SSH path is awaited by agent startup.
    const exitCode = await (parentIdentity ? launch() : launchThenStartBackgroundSync(launch));
    if (watcher) {
      await watcher.stop();
    } else {
      // An explicit environment override may not reverse-map to a registry
      // identity, so there is no safe remote destination for a scoped push.
      // The next full sync still catches standard registered profiles.
      startBackgroundProfileSync({ direction: "both", scope: { kind: "all" }, waitForLock: true });
    }
    process.exit(exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(err instanceof PromptCancelledError ? 130 : 1);
  }
}
