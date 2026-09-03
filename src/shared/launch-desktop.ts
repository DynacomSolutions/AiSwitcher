import { join } from "node:path";
import { resolveAppBundleBinary } from "./resolve-binary.ts";
import type { ToolConfig } from "../identities/types.ts";

/**
 * Best-effort desktop launch: invoke the .app bundle's real binary directly
 * (bypassing `open`/LaunchServices, which does NOT forward env vars to the
 * launched app) with the resolved identity's env var set, backgrounded.
 *
 * UNVERIFIED as of writing whether either app's embedded agent feature
 * actually reads this env var once running, versus determining its identity
 * from its own logged-in web session — see AGENTS.md for the spike outcome
 * before relying on this for claude. codex should generally prefer its native
 * `codex app [PATH]` subcommand (run through the normal wrapper path, which
 * already sets CODEX_HOME correctly) over this direct-binary approach. grok
 * and kimi have no known equivalent of either — no `grok app`/`kimi app`
 * subcommand and no confirmed desktop app bundle on this machine
 * (`/Applications/Grok.app` and `/Applications/Kimi*.app` don't exist here,
 * checked 2026-07-17) — so `--desktop` on those wrappers is unverified even
 * as a "best-effort" concept; it will simply fail resolving the app bundle
 * binary if none is installed. zai's and ali's real binary is `crush`, a
 * terminal-only CLI with no known desktop app bundle either; `--desktop` on
 * zai/ali is wired up structurally for consistency but expected to just
 * fail resolving `/Applications/Crush.app`, same as grok/kimi.
 */
export function launchDesktopApp(
  appName: "Claude" | "Codex" | "Grok" | "Kimi" | "Crush" | "Pi" | "OpenCode",
  envVarName: ToolConfig["envVarName"],
  configDirValue: string,
  extraEnvVarNames: Array<{ name: string; subdir?: string }> = [],
): void {
  const bundleBinary = resolveAppBundleBinary(appName);
  const extraEnv = Object.fromEntries(
    extraEnvVarNames.map(({ name, subdir }) => [name, subdir ? join(configDirValue, subdir) : configDirValue]),
  );
  Bun.spawn([bundleBinary], {
    env: { ...process.env, [envVarName]: configDirValue, ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  }).unref();
}
