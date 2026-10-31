import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MemberUsage } from "../../identities/claude-usage-api.ts";
import type { SwapReason, SwapResult } from "../../identities/pool/adapter.ts";
import { eventsForPool, readSwapEvents } from "../../identities/pool/ledger.ts";
import { poolStatus, swapIfLimited, swapToNext, type MemberRow, type PoolOpsDeps } from "../../identities/pool/ops.ts";
import { adapterFor } from "../../identities/pool/registry.ts";
import { performPoolSwap } from "../../identities/pool/swap.ts";
import { parseHookInput, runContinuation, type ContinueRequest } from "../../identities/claude-swap-continue.ts";
import { isAisLive, noteLiveFeatureDisabled } from "../../shared/live-mode.ts";
import { resolveInstalledAisBinary } from "../../sync/background.ts";
import { resolveHerdrBinary } from "../../shared/herdr-bin.ts";
import { installSwapHook, removeSwapHook } from "../../identities/claude-swap-hook.ts";
import { ensureClaudeTranscriptRetention } from "../../identities/claude-settings.ts";
import { expandPath, isValidIdentityKey, translateHostPath } from "../../identities/match.ts";
import { loadIdentitiesFile, saveIdentitiesFile } from "../../identities/store.ts";
import {
  DEFAULT_SWAP_THRESHOLD_PERCENT,
  memberIdentity,
  poolsOf,
  requirePool,
  SwapPoolError,
  swapCommandName,
  validateMembers,
} from "../../identities/pool/swap-pool.ts";
import type { IdentitiesFile, ToolConfig } from "../../identities/types.ts";
import { aisCacheDir, aisSwapLedgerPath } from "../../shared/ais-home.ts";
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, dim, green, yellow } from "../colors.ts";
import { createIdentity } from "../identities/actions.ts";
import { CliUsageError } from "../errors.ts";
import { helpText } from "../help.ts";
import { poolMemberUsageSplit } from "../claude-swap/attribution.ts";
import { acquireSnapshotLock, readSwapUsageFromSnapshot } from "../usage/snapshot.ts";

export interface SwapDeps extends PoolOpsDeps<any> {
  log?: (line: string) => void;
  /** Hook stdin (Claude Code's hook input JSON); default: stdin unless it is a TTY, capped at 500 ms. */
  readHookStdin?: () => Promise<string>;
  /** Starts the detached delayed continuation; default: a background `ais claude-swap continue`. */
  spawnContinuation?: (req: ContinueRequest) => void;
  /** Environment for HERDR_PANE_ID; default process.env. */
  env?: Record<string, string | undefined>;
  /** Collector snapshot `usage --json` reads; default: the shared ~/.ais/cache/usage/snapshot.json. */
  usageSnapshotPath?: string;
  /** Lock base path for live `usage` scans; default: ~/.ais/cache/usage/swap-usage-scan. */
  usageScanLockPath?: string;
}

const usageText = (cmd: string): string => `Usage: ${cmd} <subcommand>; run "ais swap help" for the list`;

function reasonFlag(flags: ParsedArgs["flags"], fallback: SwapReason): SwapReason {
  const raw = stringFlag(flags, "reason");
  if (raw === undefined) return fallback;
  if (raw !== "manual" && raw !== "auto" && raw !== "launch") throw new CliUsageError(`--reason must be manual, auto or launch (got "${raw}")`);
  return raw;
}

function pct(n: number | undefined): string {
  return n === undefined ? "-" : `${Math.round(n)}%`;
}

function reset(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  return mins < 90 ? `${mins}m` : mins < 48 * 60 ? `${(mins / 60).toFixed(1)}h` : `${Math.round(mins / 1440)}d`;
}

function describeSwap(r: SwapResult): string {
  const { to: target, from: previous } = r;
  if (r.noop) return `${r.pool}: already on ${target}`;
  const wb = r.writeBack === "written" ? "; rotated grant written back to " + (r.from ?? "its owner") : "";
  return `${r.pool}: ${previous ?? "(none)"} -> ${target} (${r.reason})${wb}`;
}

/** Cell for the optional `extra` column: share spent when known, else the label; yellow when not usable. */
function extraCell(u: MemberUsage | undefined): string {
  const x = u?.extraUsage;
  if (!x) return "-";
  const text = x.usedPercent !== undefined ? pct(x.usedPercent) : x.label;
  return x.enabled && !x.available ? yellow(text) : text;
}

function renderStatus(poolName: string, auto: boolean, threshold: number, rows: MemberRow<MemberUsage>[]): string[] {
  const name = Math.max(7, ...rows.map((r) => r.name.length));
  const lines = [`${bold(poolName)} ${dim(`auto ${auto ? `on (>=${threshold}%)` : "off"}`)}`];
  const extra = rows.some((r) => r.usage?.extraUsage?.enabled);
  lines.push(dim(`  ${" "} ${"account".padEnd(name)}  ${"5h".padStart(5)} ${"reset".padEnd(6)} ${"week".padStart(5)} ${"reset".padEnd(6)} ${extra ? "extra  " : ""}allowed`));
  for (const r of rows) {
    const u = r.usage;
    const note = u && u.status !== "live" ? dim(` (${u.error ?? u.status})`) : "";
    lines.push(
      `  ${r.active ? green("*") : " "} ${r.name.padEnd(name)}  ${pct(u?.fiveHour?.utilization).padStart(5)} ${reset(u?.fiveHour?.resetsAt).padEnd(6)} ${pct(u?.sevenDay?.utilization).padStart(5)} ${reset(u?.sevenDay?.resetsAt).padEnd(6)} ${extra ? extraCell(u) + " " : ""}${r.allowed ? "yes" : yellow("no")}${note}`,
    );
  }
  return lines;
}

function renderWindowStatus(poolName: string, auto: boolean, threshold: number, rows: MemberRow[]): string[] {
  const name = Math.max(7, ...rows.map((r) => r.name.length));
  const lines = [`${bold(poolName)} ${dim(`auto ${auto ? `on (>=${threshold}%)` : "off"}`)}`];
  const extra = rows.some((r) => r.usage?.extraUsage?.enabled);
  lines.push(dim(`  ${" "} ${"account".padEnd(name)}  usage  ${extra ? "extra  " : ""}allowed`));
  for (const r of rows) {
    const u = r.usage;
    const note = u && u.status !== "live" ? dim(` (${u.error ?? u.status})`) : "";
    const windows = (u?.windows ?? []).map((w) => `${w.label} ${pct(w.utilization)}${w.resetsAt ? ` (${reset(w.resetsAt)})` : ""}`).join("  ") || "-";
    lines.push(`  ${r.active ? green("*") : " "} ${r.name.padEnd(name)}  ${windows}  ${extra ? extraCell(u as MemberUsage | undefined) + "  " : ""}${r.allowed ? "yes" : yellow("no")}${note}`);
  }
  return lines;
}

async function defaultReadHookStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return Promise.race([Bun.stdin.text(), new Promise<string>((r) => setTimeout(() => r(""), 500))]);
}

function defaultSpawnContinuation(req: ContinueRequest): void {
  // detached: own session, so it survives the hook's process group being signalled. execPath is the compiled ais when none is installed.
  const child = Bun.spawn([resolveInstalledAisBinary() ?? process.execPath, "claude-swap", "continue", `--pane=${req.paneId}`, `--transcript=${req.transcriptPath}`, `--session=${req.sessionId}`, `--failure-at-ms=${req.failureAtMs}`], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  child.unref();
}

/** After a hook-driven swap, arranges a delayed "continue" for sessions whose mod cannot do it. Never throws. */
async function scheduleHookContinuation(deps: SwapDeps, failureAtMs: number): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    if (isAisLive(env)) {
      noteLiveFeatureDisabled("Claude swap auto-continue");
      return;
    }
    const paneId = env.HERDR_PANE_ID?.trim();
    if (!paneId || !resolveHerdrBinary(env)) return;
    const input = parseHookInput(await (deps.readHookStdin ?? defaultReadHookStdin)());
    if (!input.transcriptPath || !input.sessionId) return;
    (deps.spawnContinuation ?? defaultSpawnContinuation)({ paneId, transcriptPath: input.transcriptPath, sessionId: input.sessionId, failureAtMs });
  } catch (error) {
    console.error(`claude-swap: continuation fallback skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function mutatePool(
  config: ToolConfig,
  deps: SwapDeps,
  poolKey: string | undefined,
  apply: (file: IdentitiesFile, pool: ReturnType<typeof requirePool>) => string,
): Promise<string> {
  const path = deps.registryPath ?? config.identitiesJsonPath;
  const file = await loadIdentitiesFile(path);
  const pool = requirePool(file, poolKey, config.toolName);
  const message = apply(file, pool);
  await saveIdentitiesFile(path, file);
  return message;
}

/** `ais swap <tool> ...` (and the `ais claude-swap ...` alias): one command
 * set over the generic pool core, driven by the tool's adapter. */
export async function runSwapCommand(tool: string, positionals: string[], flags: ParsedArgs["flags"], deps: SwapDeps = {}): Promise<void> {
  const adapter = adapterFor(tool as ToolConfig["toolName"]);
  if (!adapter) throw new CliUsageError(`No swap pool support for "${tool}". Supported: claude, codex, kimi, pi.`);
  const config = adapter.config;
  const cmd = swapCommandName(tool);
  const USAGE = usageText(cmd);
  const log = deps.log ?? ((line: string) => console.log(line));
  // Sessions that cannot follow the swap (liveSwap: false adapters) must relaunch.
  const runningWarning = (r: SwapResult): void => {
    if (r.runningSessions) log(yellow(`  ${r.runningSessions} running session${r.runningSessions === 1 ? "" : "s"} keep the old account until relaunched ("${tool} resume")`));
  };
  const json = boolFlag(flags, "json");
  const opsDeps = { ...deps };
  const registryPath = deps.registryPath ?? config.identitiesJsonPath;
  const known = new Set(["status", "to", "next", "pool", "allow", "disallow", "auto", "usage", "hook", "continue", "help"]);
  const first = positionals[0];
  const sub = first === undefined ? "status" : known.has(first) ? first : "status";
  const rest = first !== undefined && known.has(first) ? positionals.slice(1) : positionals;
  const poolFlag = stringFlag(flags, "pool");
  const configDirFlag = stringFlag(flags, "config-dir");
  const expectedActive = stringFlag(flags, "expected-active");
  const failureAtRaw = stringFlag(flags, "failure-at-ms");
  const failureAtMs = failureAtRaw === undefined ? undefined : Number(failureAtRaw);
  if (failureAtMs !== undefined && (!Number.isFinite(failureAtMs) || failureAtMs < 0)) throw new CliUsageError("--failure-at-ms must be a non-negative timestamp in milliseconds");
  let scopedPool = poolFlag;
  if (!scopedPool && configDirFlag !== undefined && (sub === "status" || sub === "next")) {
    // An unset variable in the hook (`--config-dir="$CLAUDE_CONFIG_DIR"`) arrives as "".
    if (configDirFlag.trim() === "") throw new SwapPoolError("--config-dir is empty (is CLAUDE_CONFIG_DIR set?); pass a pool config directory or use --pool=");
    const norm = (dir: string) => resolve(expandPath(dir)); // resolve() drops trailing slashes
    const configDir = norm(configDirFlag);
    const matching = poolsOf(await loadIdentitiesFile(registryPath)).filter((pool) => norm(pool.configDir) === configDir);
    if (matching.length !== 1) throw new SwapPoolError(`No unique ${tool} swap pool uses config directory "${configDirFlag}"`);
    scopedPool = matching[0]!.name;
  }

  {
    switch (sub) {
      case "help":
        return log(helpText(["swap"]));

      case "status": {
        const status = await poolStatus(adapter, opsDeps, rest[0] ?? scopedPool, { usage: !boolFlag(flags, "no-usage") });
        if (json) {
          const events = eventsForPool(await readSwapEvents(deps.ledgerPath ?? aisSwapLedgerPath(tool)), status.pool);
          const lastSwapAt = events.at(-1)?.ts;
          return log(JSON.stringify({ pool: status.pool.name, active: status.pool.swapPool.active ?? null, ...(lastSwapAt ? { lastSwapAt } : {}), auto: status.pool.swapPool.auto === true, thresholdPercent: status.thresholdPercent, accounts: status.rows }, null, 2));
        }
        for (const line of (tool === "claude" ? renderStatus : renderWindowStatus)(status.pool.name, status.pool.swapPool.auto === true, status.thresholdPercent, status.rows as MemberRow<MemberUsage>[])) log(line);
        return;
      }

      case "to": {
        const account = rest[0];
        if (!account) throw new CliUsageError(`Usage: ${cmd} to <account> [--pool=] [--force]`);
        const r = await performPoolSwap(adapter, { registryPath, ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}), ...(poolFlag ? { pool: poolFlag } : {}), target: account, reason: reasonFlag(flags, "manual"), force: boolFlag(flags, "force") });
        if (json) return log(JSON.stringify(r, null, 2));
        log(`${green("✔")} ${describeSwap(r)}`);
        for (const n of r.notes) log(dim(`  ${n}`));
        return runningWarning(r);
      }

      case "next": {
        const reason = reasonFlag(flags, boolFlag(flags, "if-limited") ? "auto" : "manual");
        if (boolFlag(flags, "if-limited")) {
          const startedAtMs = Date.now();
          const outcome = await swapIfLimited(adapter, opsDeps, scopedPool, reason, {
            assumeLimited: boolFlag(flags, "assume-limited"),
            trustLimitEvidence: boolFlag(flags, "trust-limit-evidence"),
            ...(expectedActive ? { expectedActive } : {}),
            ...(failureAtMs !== undefined ? { failureAtMs } : {}),
          });
          const handled = outcome.action === "swapped" || (outcome.action === "skipped" && /already handled/.test(outcome.why));
          if (tool === "claude" && reason === "auto" && handled) await scheduleHookContinuation(deps, failureAtMs ?? startedAtMs);
          if (json) return log(JSON.stringify(outcome, null, 2));
          log(outcome.action === "swapped" ? `${green("✔")} ${describeSwap(outcome.result)}` : dim(`${tool}-swap: ${outcome.action}${"why" in outcome ? ` (${outcome.why})` : ""}`));
          return outcome.action === "swapped" ? runningWarning(outcome.result) : undefined;
        }
        const r = await swapToNext(adapter, opsDeps, scopedPool, reason);
        if (!r) throw new SwapPoolError("No other allowed account to switch to.");
        if (json) return log(JSON.stringify(r, null, 2));
        log(`${green("✔")} ${describeSwap(r)}`);
        return runningWarning(r);
      }

      case "continue": {
        // Hidden: started detached by the StopFailure hook; waits, then types the continuation prompt into the herdr pane.
        const paneId = stringFlag(flags, "pane");
        const transcriptPath = stringFlag(flags, "transcript");
        const sessionId = stringFlag(flags, "session");
        if (tool !== "claude" || !paneId || !transcriptPath || !sessionId || failureAtMs === undefined) throw new CliUsageError("continue is internal: --pane, --transcript, --session and --failure-at-ms are required");
        const bin = resolveHerdrBinary();
        if (!bin) return;
        const result = await runContinuation({ paneId, transcriptPath, sessionId, failureAtMs }, {
          herdr: async (args) => (await Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited),
        });
        return log(dim(`claude-swap: continuation ${result}`));
      }

      case "allow":
      case "disallow": {
        const account = rest[0];
        if (!account) throw new CliUsageError(`Usage: ${cmd} ${sub} <account> [--pool=]`);
        const msg = await mutatePool(config, deps, poolFlag, (file, pool) => {
          const member = memberIdentity(file, pool, account);
          const set = new Set(pool.swapPool.disallowed ?? []);
          if (sub === "allow") set.delete(member.name);
          else set.add(member.name);
          if (set.size > 0) pool.swapPool.disallowed = pool.swapPool.accounts.filter((n) => set.has(n));
          else delete pool.swapPool.disallowed;
          return `${member.name} is ${sub === "allow" ? "allowed" : "not allowed"} in pool ${pool.name}`;
        });
        return log(`${green("✔")} ${msg}`);
      }

      case "auto": {
        const mode = rest[0];
        if (mode !== "on" && mode !== "off") throw new CliUsageError(`Usage: ${cmd} auto on|off [--pool=] [--threshold=95]`);
        const rawThreshold = stringFlag(flags, "threshold");
        const threshold = rawThreshold === undefined ? undefined : Number(rawThreshold);
        if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 1 || threshold > 100)) {
          throw new CliUsageError("--threshold must be a number from 1 to 100");
        }
        const msg = await mutatePool(config, deps, poolFlag, (_file, pool) => {
          pool.swapPool.auto = mode === "on";
          if (threshold !== undefined) pool.swapPool.thresholdPercent = threshold;
          return `auto swap ${mode} for pool ${pool.name} (threshold ${pool.swapPool.thresholdPercent ?? DEFAULT_SWAP_THRESHOLD_PERCENT}%)`;
        });
        return log(`${green("✔")} ${msg}${mode === "on" ? dim(" - needs the ais console daemon (ais web start)") : ""}`);
      }

      case "pool": {
        if (rest[0] !== "create") throw new CliUsageError(USAGE);
        const name = rest[1];
        if (!name || !isValidIdentityKey(name)) throw new CliUsageError(`Usage: ${cmd} pool create <name> --accounts=a,b[,c] [--config-dir=]  (name: lowercase letters, digits, hyphens)`);
        const requested = listFlag(flags, "accounts");
        if (!requested) throw new CliUsageError("Missing required --accounts=a,b[,c]");
        const file = await loadIdentitiesFile(registryPath);
        const accounts = validateMembers(file, name, requested, tool, adapter.memberProblem);
        const configDir = stringFlag(flags, "config-dir") ?? join(config.identitiesRootDir, name);
        const dir = translateHostPath(expandPath(configDir)); // fs form; the registry keeps the host form
        // Two pools sharing one folder would fight over its credentials.
        if (poolsOf(file).some((p) => expandPath(p.configDir) === dir) || file.identities.some((i) => expandPath(i.configDir) === dir)) {
          throw new SwapPoolError(`configDir ${dir} is already used by another identity`);
        }
        const identity = createIdentity(file, { name, label: name, description: `${tool.charAt(0).toUpperCase()}${tool.slice(1)} swap pool`, configDir });
        identity.swapPool = { accounts };
        await mkdir(dir, { recursive: true });
        if (tool === "claude") await ensureClaudeTranscriptRetention(dir);
        await saveIdentitiesFile(registryPath, file);
        log(`${green("✔")} Created swap pool ${bold(name)} (configDir: ${configDir}; accounts: ${accounts.join(", ")}).`);
        // Secrets reach the pool only through the swap: activate the first
        // member that has a login.
        for (const account of accounts) {
          try {
            const r = await performPoolSwap(adapter, { registryPath, ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}), pool: name, target: account, reason: "manual" });
            log(`${green("✔")} ${describeSwap(r)}`);
            return;
          } catch (err) {
            log(yellow(`  could not activate ${account}: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        log(yellow(`  no member could be activated yet; log in to each account identity, then run: ${cmd} to <account>`));
        return;
      }

      case "hook": {
        if (tool !== "claude") throw new CliUsageError(`"hook" is Claude-only (it installs a Claude Code StopFailure hook); ${tool} pools swap through the console daemon or "${cmd} next --if-limited".`);
        const mode = rest[0];
        if (mode !== "on" && mode !== "off") throw new CliUsageError("Usage: ais claude-swap hook on|off [--pool=]");
        const file = await loadIdentitiesFile(registryPath);
        const pool = requirePool(file, poolFlag, tool);
        if (mode === "on") {
          await installSwapHook(pool.configDir);
          return log(`${green("✔")} StopFailure(rate_limit) hook installed in ${join(pool.configDir, "settings.json")}`);
        }
        const removed = await removeSwapHook(pool.configDir);
        return log(removed ? `${green("✔")} hook removed` : dim("no claude-swap hook was installed"));
      }

      case "usage": {
        if (tool !== "claude" && tool !== "codex") throw new CliUsageError(`"usage" is not available for ${tool} pools: ${tool} keeps no per-message token log to split by member.`);
        const days = Number(stringFlag(flags, "days") ?? 30);
        const file = await loadIdentitiesFile(registryPath);
        const pool = requirePool(file, rest[0] ?? poolFlag, tool);
        // A full transcript scan takes minutes on a large host, so `--json` (the mod's call, once per session) reads the
        // collector's snapshot instead. `--scan` and the table view still scan, one at a time.
        if (json && tool === "claude" && !boolFlag(flags, "scan")) {
          const stored = readSwapUsageFromSnapshot(pool.name, deps.usageSnapshotPath);
          if (!stored) throw new SwapPoolError(`no usage snapshot for pool ${pool.name}: start the collector (ais-usage-snapshot.service) or pass --scan`);
          return log(JSON.stringify({ pool: stored.pool, days: stored.days, members: stored.members, generatedAt: stored.at, stale: stored.stale }, null, 2));
        }
        const lockBase = deps.usageScanLockPath ?? join(aisCacheDir(), "usage", "swap-usage-scan");
        await mkdir(dirname(lockBase), { recursive: true, mode: 0o700 });
        const releaseScan = await acquireSnapshotLock(lockBase);
        if (!releaseScan) throw new SwapPoolError("another usage scan is already running; try again when it finishes or use the collector snapshot (usage --json)");
        let split;
        try {
          split = await poolMemberUsageSplit(pool, { days, ledgerPath: deps.ledgerPath ?? aisSwapLedgerPath(tool), tool: tool as "claude" | "codex" });
        } finally {
          await releaseScan();
        }
        if (json) return log(JSON.stringify(split, null, 2));
        log(bold(`${pool.name}: transcript usage by active member, last ${days}d`));
        for (const row of split.members) {
          log(`  ${row.member.padEnd(16)} ${String(row.messages).padStart(7)} msgs  in ${row.input}  out ${row.output}  cacheR ${row.cacheRead}  cacheW ${row.cacheWrite}`);
        }
        return;
      }
    }
  }
}

export const runClaudeSwapCommand = (positionals: string[], flags: ParsedArgs["flags"], deps: SwapDeps = {}): Promise<void> => runSwapCommand("claude", positionals, flags, deps);
