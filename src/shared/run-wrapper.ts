import type { ToolConfig } from "../identities/types.ts";
import { basename, join } from "node:path";
import { resolveIdentity } from "../identities/resolve.ts";
import { PromptCancelledError, RetiredIdentityError } from "../identities/errors.ts";
import { isRetired } from "../identities/retired.ts";
import { activeParentIdentity, parseCliArgs, resolveNestedIdentity } from "./cli-args.ts";
import { realpathSync } from "node:fs";
import { resolveRealBinary, shimExecEnvVar } from "./resolve-binary.ts";
import { IDENTITY_SESSION_MARKER } from "./exec.ts";
import { launchDesktopApp } from "./launch-desktop.ts";
import { launchThenStartBackgroundSync } from "../sync/background.ts";
import { migrateLegacyAisHome } from "./migrate-ais-home.ts";
import { codexPlatformArgs } from "./codex-platform-config.ts";
import { projectSharedCodexConfigForLaunch } from "./codex-shared-config.ts";
import { codexSubcommandConfigArgs } from "./codex-config-args.ts";
import { projectGlobalMemoryForLaunch } from "./global-memory.ts";
import { gatePluginArgs } from "./plugin-gating.ts";
import { poolLaunchCheck } from "../identities/pool/launch.ts";
import { adapterFor } from "../identities/pool/registry.ts";
import { runLaunchGate } from "../spend/gate.ts";
import type { HerdrChatTool } from "./herdr-chat-source.ts";
import { promptFromCliArgs } from "./herdr-tab-title.ts";
import { launchWithSession, runSessionSidecar, takeSidecarSpec } from "./session-sidecar.ts";

export async function runWrapper(
  cfg: ToolConfig,
  appName: "Claude" | "Codex" | "Grok" | "Kimi" | "Crush" | "Pi" | "OpenCode",
  beforeLaunch?: (configDir: string) => Promise<unknown>,
): Promise<void> {
  // Detached sidecar re-entry (see session-sidecar.ts): none of the launch
  // logic below applies, and the terminal is never touched.
  const sidecarSpec = takeSidecarSpec(process.argv, process.env);
  if (sidecarSpec) {
    await runSessionSidecar(cfg, sidecarSpec).catch(() => {});
    process.exit(0);
  }
  try {
    // Self-healing, idempotent, and must run before resolveRealBinary()
    // (which now defaults to looking under ~/.ais/npm) or any sync/background
    // work (which now defaults to ~/.ais/remote-cache and ~/.ais/config) —
    // see migrate-ais-home.ts. Never throws.
    await migrateLegacyAisHome();
    const parsed = parseCliArgs(cfg.toolName, process.argv.slice(2));
    const parentIdentity = activeParentIdentity(cfg.envVarName, process.env);

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
      ...(parsed.poolFlag !== undefined ? { explicitPoolFlag: parsed.poolFlag } : {}),
      ...(parsed.pickerMode ? { pickerMode: parsed.pickerMode } : {}),
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

    // Swap pools only (tools with a registered pool adapter): one bounded
    // pre-launch check (bootstrap, or swap away from a member over its
    // threshold). Never blocks for long, never throws; other identities are
    // untouched.
    const poolAdapter = resolved.identity?.swapPool ? adapterFor(cfg.toolName) : undefined;
    if (poolAdapter && resolved.identity) {
      const note = await poolLaunchCheck(poolAdapter, resolved.identity);
      if (note) console.error(note);
    }

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
    const chatTitleTools: HerdrChatTool[] = ["claude", "codex", "grok", "kimi", "zai", "ali", "opencode"];
    const chatTitleTool = chatTitleTools.find((tool): tool is HerdrChatTool => tool === cfg.toolName);
    const inheritedTitleOwner = process.env.AIS_HERDR_TITLE_OWNER_PID;
    const wantsTitles = !parentIdentity && (!inheritedTitleOwner || inheritedTitleOwner === String(process.pid)) && chatTitleTool;
    const initialPrompt = promptFromCliArgs(cfg.toolName, parsed.cleanedArgv);
    // The real agent replaces this process (execve), so in-session work (sync
    // watcher, Herdr tab titles, post-exit sync) lives in a detached sidecar;
    // see launchWithSession(). Nothing in the automatic SSH path is awaited by
    // agent startup. Only reached with an exit code when execve was unavailable.
    const exitCode = await launchWithSession(
      cfg,
      {
        ...(resolved.identity
          ? { identity: { name: resolved.identity.name, configDir: resolved.identity.configDir } }
          : {}),
        configDirValue: resolved.configDirValue,
        cwd: process.cwd(),
        syncAtLaunch: !parentIdentity,
        ...(wantsTitles && chatTitleTool
          ? { title: { tool: chatTitleTool, ...(initialPrompt !== undefined ? { initialPrompt } : {}) } }
          : {}),
      },
      {
        path: realBinary,
        args: launchArgs,
        env: {
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
        },
      },
    );
    process.exit(exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(err instanceof PromptCancelledError ? 130 : 1);
  }
}
