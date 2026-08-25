import { loadIdentitiesFile } from "./identities/store.ts";
import { resolveChromeMcpTarget, type ChromeMcpTargetResolution } from "./identities/chrome-profile.ts";
import { chromeMcpConfigFor, ensureChromeMcpRunning, openUrlInChromeMcp } from "./identities/chrome-mcp.ts";
import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  ZAI_CONFIG,
} from "./identities/tool-configs.ts";
import { resolveRealBinary } from "./shared/resolve-binary.ts";
import { execReal, IDENTITY_SESSION_MARKER } from "./shared/exec.ts";

// ALI_CONFIG must come BEFORE ZAI_CONFIG: an ali session sets BOTH
// ALI_CONFIG_DIR (its own envVarName) and CRUSH_GLOBAL_CONFIG (mirrored via
// its extraEnvVarNames, see tool-configs.ts's ALI_CONFIG), while a zai
// session sets only CRUSH_GLOBAL_CONFIG. Checking ALI_CONFIG_DIR first is
// what disambiguates the two: putting ZAI_CONFIG first would make
// `.find()` below match every ali session as a zai one, since
// CRUSH_GLOBAL_CONFIG is present in both.
const TOOL_CONFIGS = [CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG, ALI_CONFIG, ZAI_CONFIG];

/**
 * Only ever intercept the single plain shape a link-opening OAuth/callback
 * flow actually uses: `open <url>`, zero other flags. Anything else (open a
 * file, `open -a SomeApp`, `open .` to reveal in Finder, reveal/background
 * flags, multiple args, non-http schemes) passes straight through untouched
 * — this shim must never change behavior for ordinary `open` usage.
 */
function urlToOpenInBrowser(argv: string[]): string | undefined {
  if (argv.length !== 1) return undefined;
  return /^https?:\/\//i.test(argv[0]!) ? argv[0] : undefined;
}

/**
 * Only resolves anything when IDENTITY_SESSION_MARKER is present — proof
 * this process descends from our own claude/codex/grok/kimi/zai wrapper's
 * spawn, not just "CLAUDE_CONFIG_DIR/CODEX_HOME/GROK_HOME/KIMI_CODE_HOME/
 * CRUSH_GLOBAL_CONFIG happen to be set" (which this project also treats as a
 * legitimate, permanent, user-exported override — see resolve.ts — so keying
 * off those alone would redirect unrelated `open` calls in any shell where an
 * identity is pinned that way). zai and ali share the same real binary
 * (`crush`) but have distinct envVarNames (CRUSH_GLOBAL_CONFIG vs.
 * ALI_CONFIG_DIR, see tool-configs.ts's ALI_CONFIG for why), so this
 * `.find()` still has no collision to worry about as long as ALI_CONFIG is
 * ordered before ZAI_CONFIG in TOOL_CONFIGS above.
 */
async function resolveActiveChromeMcpTarget(cwd: string): Promise<ChromeMcpTargetResolution | null> {
  if (!process.env[IDENTITY_SESSION_MARKER]) return null;

  const active = TOOL_CONFIGS.find((cfg) => process.env[cfg.envVarName]);
  if (!active) return null;

  const configDirValue = process.env[active.envVarName]!;
  const file = await loadIdentitiesFile(active.identitiesJsonPath);
  return resolveChromeMcpTarget(cwd, configDirValue, file);
}

async function main(): Promise<never> {
  const argv = process.argv.slice(2);
  const url = process.platform === "darwin" ? urlToOpenInBrowser(argv) : undefined;
  const realOpen = resolveRealBinary("open");

  if (url) {
    let target: ChromeMcpTargetResolution | null = null;
    try {
      target = await resolveActiveChromeMcpTarget(process.cwd());
    } catch (err) {
      // Never let a malformed/unreadable identities.json break a plain
      // `open` call — fall through to unmodified passthrough below. Still
      // surface it, since this is one of the few failure modes actually
      // possible to detect and report from inside this shim.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`open: chrome-mcp target resolution failed, falling through unmodified: ${message}`);
    }

    if (target) {
      const config = chromeMcpConfigFor(target.identityName);
      if (!config) {
        console.error(
          `open: identity "${target.identityName}" has no Chrome (Claude MCP) instance configured — falling through to unmodified \`open\`.`,
        );
      } else {
        const port = await ensureChromeMcpRunning(target.identityName);
        if (port && (await openUrlInChromeMcp(port, url))) {
          console.error(
            `open: redirected to Chrome (Claude MCP) — identity "${target.identityName}" (${target.source}` +
              `${target.label ? ` — ${target.label}` : ""}), port ${port}`,
          );
          process.exit(0);
        }
        console.error(
          `open: identity "${target.identityName}"'s Chrome (Claude MCP) instance (port ${config.port}) ` +
            `did not come up — falling through to unmodified \`open\`. Check \`devserver ls\` and the ` +
            `chrome-mcp-profile skill's Recovery section.`,
        );
      }
    }
  }

  return execReal(realOpen, argv, {});
}

await main();
