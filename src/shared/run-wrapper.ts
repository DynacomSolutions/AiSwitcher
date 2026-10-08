import type { ToolConfig } from "../identities/types.ts";
import { basename, join } from "node:path";
import { resolveIdentity } from "../identities/resolve.ts";
import { PromptCancelledError, RetiredIdentityError } from "../identities/errors.ts";
import { isRetired } from "../identities/retired.ts";
import { parseCliArgs, resolveNestedIdentity } from "./cli-args.ts";
import { realpathSync } from "node:fs";
import { resolveRealBinary, shimExecEnvVar } from "./resolve-binary.ts";
import { IDENTITY_SESSION_MARKER, spawnReal } from "./exec.ts";
import { launchDesktopApp } from "./launch-desktop.ts";
import { launchThenStartBackgroundSync, startBackgroundProfileSync } from "../sync/background.ts";
import { startProfileSyncWatcher } from "../sync/watch.ts";
import { migrateLegacyAisHome } from "./migrate-ais-home.ts";
import { codexPlatformArgs } from "./codex-platform-config.ts";
import { projectSharedCodexConfigForLaunch } from "./codex-shared-config.ts";
import { codexSubcommandConfigArgs } from "./codex-config-args.ts";
import { projectGlobalMemoryForLaunch } from "./global-memory.ts";
import { gatePluginArgs } from "./plugin-gating.ts";
import { runLaunchGate } from "../spend/gate.ts";
import { readHerdrChatTitle, type HerdrChatTool } from "./herdr-chat-source.ts";
import { aisHerdrTabLabelsPath } from "./ais-home.ts";
import { HerdrTabTitleWatcher, promptFromCliArgs } from "./herdr-tab-title.ts";

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

    // Safety net: resolution already refuses retired identities, but nothing
    // downstream (spend gate, sync, spawn) may ever act for one.
    if (resolved.identity && isRetired(resolved.identity)) {
      throw new RetiredIdentityError(cfg.toolName, resolved.identity);
    }

    // SPEND GUARD launch gate: before ANY side effect (auth refreshes, sync
    // watchers, desktop launches, the real binary), check the AWS account's
    // last-known spend state. mode decides the breach response: "warn" (the
    // default, also with no config file) prints one loud stderr warning and
    // continues the launch; "enforce" refuses to start a new wrapped
    // session (exit 1). Enforcement runs on last-known cached state (<50ms
    // fresh); a missing or stale cache queues an opportunistic background
    // refresh and never blocks on missing data. No override exists by
    // design.
    const gate = await runLaunchGate({
      toolName: cfg.toolName,
      ...(resolved.identity ? { identity: resolved.identity } : {}),
      configDir: resolved.configDirValue,
    });
    if (gate.decision === "block") {
      console.error(gate.refusal);
      process.exit(1);
    }
    if (gate.warn) console.error(gate.warn);

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
    // Single-instance tools (pi) launch unseeded when nothing matched: omit
    // the marker entirely rather than emitting a basename pseudo-identity
    // ("agent") that nested tool launches would inherit and then fail to
    // resolve (UnknownIdentityError in the CHILD tool's registry). Other
    // tools keep the historical basename fallback.
    const activeIdentity = resolved.identity?.name
      ?? (cfg.singleInstanceDir ? undefined : basename(resolved.configDirValue.replace(/\/$/, "")));
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
    const sharedConfigArgs = await projectSharedCodexConfigForLaunch(
      cfg,
      resolved.configDirValue,
      platformArgs,
    );
    const memoryProjection = await projectGlobalMemoryForLaunch(
      cfg,
      resolved.configDirValue,
      sharedConfigArgs,
    );
    const launchArgs = cfg.toolName === "codex"
      ? codexSubcommandConfigArgs(memoryProjection.argv)
      : gatePluginArgs(cfg.toolName, memoryProjection.argv, process.cwd());
    const launch = () =>
      spawnReal(realBinary, launchArgs, {
        [cfg.envVarName]: resolved.configDirValue,
        // Re-entry guard: see resolveRealBinary(). Holds the REAL binary's
        // realpath, so a legitimately nested shim launch (different path) passes.
        [shimExecEnvVar(cfg.realBinaryName)]: (() => {
          try {
            return realpathSync(realBinary);
          } catch {
            return realBinary;
          }
        })(),
        ...extraEnv,
        ...memoryProjection.env,
        ...((process.env.AIS_HERDR_TITLE_OWNER_PID ?? (parentIdentity || cfg.toolName !== "pi" ? String(process.pid) : undefined))
          ? { AIS_HERDR_TITLE_OWNER_PID: process.env.AIS_HERDR_TITLE_OWNER_PID ?? String(process.pid) }
          : {}),
        ...(activeIdentity !== undefined ? { [IDENTITY_SESSION_MARKER]: activeIdentity } : {}),
      });
    const chatTitleTools: HerdrChatTool[] = ["claude", "codex", "grok", "kimi", "zai", "ali", "opencode"];
    const chatTitleTool = chatTitleTools.find((tool): tool is HerdrChatTool => tool === cfg.toolName);
    const inheritedTitleOwner = process.env.AIS_HERDR_TITLE_OWNER_PID;
    const titleWatcher = !parentIdentity && (!inheritedTitleOwner || inheritedTitleOwner === String(process.pid)) && chatTitleTool
      ? new HerdrTabTitleWatcher({
          agent: cfg.realBinaryName,
          tool: chatTitleTool,
          configDir: resolved.configDirValue,
          cwd: process.cwd(),
          initialPrompt: promptFromCliArgs(cfg.toolName, parsed.cleanedArgv),
          readTitle: readHerdrChatTitle,
          statePath: aisHerdrTabLabelsPath(),
        })
      : undefined;
    await titleWatcher?.start();
    // The real agent is spawned before the detached sync worker. Nothing in
    // the automatic SSH path is awaited by agent startup.
    let exitCode: number;
    try {
      exitCode = await (parentIdentity ? launch() : launchThenStartBackgroundSync(launch));
    } finally {
      titleWatcher?.stop();
    }
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
