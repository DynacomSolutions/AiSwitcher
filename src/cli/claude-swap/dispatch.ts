import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performSwap, type SwapReason, type SwapResult } from "../../identities/claude-swap.ts";
import { swapIfLimited, swapToNext, poolStatus, type MemberRow, type OpsDeps } from "../../identities/claude-swap-ops.ts";
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
  validateMembers,
} from "../../identities/swap-pool.ts";
import { CLAUDE_CONFIG } from "../../identities/tool-configs.ts";
import type { IdentitiesFile } from "../../identities/types.ts";
import { aisClaudeSwapLedgerPath } from "../../shared/ais-home.ts";
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, dim, green, yellow } from "../colors.ts";
import { createIdentity } from "../identities/actions.ts";
import { CliUsageError } from "../errors.ts";
import { poolMemberUsageSplit } from "./attribution.ts";

export interface ClaudeSwapDeps extends OpsDeps {
  log?: (line: string) => void;
}

const USAGE = `Usage:
  ais claude-swap [status] [pool] [--json] [--no-usage]
  ais claude-swap to <account> [--pool=] [--force]
  ais claude-swap next [--pool=] [--if-limited] [--reason=manual|auto|launch]
  ais claude-swap pool create <name> --accounts=a,b[,c] [--config-dir=]
  ais claude-swap allow|disallow <account> [--pool=]
  ais claude-swap auto on|off [--pool=] [--threshold=95]
  ais claude-swap hook on|off [--pool=]   (optional StopFailure rate_limit hook in the pool's settings.json)
  ais claude-swap usage [pool] [--days=30] [--json]`;

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

function renderStatus(poolName: string, auto: boolean, threshold: number, rows: MemberRow[]): string[] {
  const name = Math.max(7, ...rows.map((r) => r.name.length));
  const lines = [`${bold(poolName)} ${dim(`auto ${auto ? `on (>=${threshold}%)` : "off"}`)}`];
  lines.push(dim(`  ${" "} ${"account".padEnd(name)}  ${"5h".padStart(5)} ${"reset".padEnd(6)} ${"week".padStart(5)} ${"reset".padEnd(6)} allowed`));
  for (const r of rows) {
    const u = r.usage;
    const note = u && u.status !== "live" ? dim(` (${u.error ?? u.status})`) : "";
    lines.push(
      `  ${r.active ? green("*") : " "} ${r.name.padEnd(name)}  ${pct(u?.fiveHour?.utilization).padStart(5)} ${reset(u?.fiveHour?.resetsAt).padEnd(6)} ${pct(u?.sevenDay?.utilization).padStart(5)} ${reset(u?.sevenDay?.resetsAt).padEnd(6)} ${r.allowed ? "yes" : yellow("no")}${note}`,
    );
  }
  return lines;
}

async function mutatePool(
  deps: ClaudeSwapDeps,
  poolKey: string | undefined,
  apply: (file: IdentitiesFile, pool: ReturnType<typeof requirePool>) => string,
): Promise<string> {
  const path = deps.registryPath ?? CLAUDE_CONFIG.identitiesJsonPath;
  const file = await loadIdentitiesFile(path);
  const pool = requirePool(file, poolKey);
  const message = apply(file, pool);
  await saveIdentitiesFile(path, file);
  return message;
}

export async function runClaudeSwapCommand(positionals: string[], flags: ParsedArgs["flags"], deps: ClaudeSwapDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const json = boolFlag(flags, "json");
  const opsDeps: OpsDeps = { ...deps };
  const registryPath = deps.registryPath ?? CLAUDE_CONFIG.identitiesJsonPath;
  const known = new Set(["status", "to", "next", "pool", "allow", "disallow", "auto", "usage", "hook", "help"]);
  const first = positionals[0];
  const sub = first === undefined ? "status" : known.has(first) ? first : "status";
  const rest = first !== undefined && known.has(first) ? positionals.slice(1) : positionals;
  const poolFlag = stringFlag(flags, "pool");

  {
    switch (sub) {
      case "help":
        return log(USAGE);

      case "status": {
        const status = await poolStatus(opsDeps, rest[0] ?? poolFlag, { usage: !boolFlag(flags, "no-usage") });
        if (json) {
          return log(JSON.stringify({ pool: status.pool.name, active: status.pool.swapPool.active ?? null, auto: status.pool.swapPool.auto === true, thresholdPercent: status.thresholdPercent, accounts: status.rows }, null, 2));
        }
        for (const line of renderStatus(status.pool.name, status.pool.swapPool.auto === true, status.thresholdPercent, status.rows)) log(line);
        return;
      }

      case "to": {
        const account = rest[0];
        if (!account) throw new CliUsageError("Usage: ais claude-swap to <account> [--pool=] [--force]");
        const r = await performSwap({ registryPath, ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}), ...(poolFlag ? { pool: poolFlag } : {}), target: account, reason: reasonFlag(flags, "manual"), force: boolFlag(flags, "force") });
        if (json) return log(JSON.stringify(r, null, 2));
        log(`${green("✔")} ${describeSwap(r)}`);
        for (const n of r.notes) log(dim(`  ${n}`));
        return;
      }

      case "next": {
        const reason = reasonFlag(flags, boolFlag(flags, "if-limited") ? "auto" : "manual");
        if (boolFlag(flags, "if-limited")) {
          const outcome = await swapIfLimited(opsDeps, poolFlag, reason, { assumeLimited: boolFlag(flags, "assume-limited") });
          if (json) return log(JSON.stringify(outcome, null, 2));
          log(outcome.action === "swapped" ? `${green("✔")} ${describeSwap(outcome.result)}` : dim(`claude-swap: ${outcome.action}${"why" in outcome ? ` (${outcome.why})` : ""}`));
          return;
        }
        const r = await swapToNext(opsDeps, poolFlag, reason);
        if (!r) throw new SwapPoolError("No other allowed account to switch to.");
        if (json) return log(JSON.stringify(r, null, 2));
        return log(`${green("✔")} ${describeSwap(r)}`);
      }

      case "allow":
      case "disallow": {
        const account = rest[0];
        if (!account) throw new CliUsageError(`Usage: ais claude-swap ${sub} <account> [--pool=]`);
        const msg = await mutatePool(deps, poolFlag, (file, pool) => {
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
        if (mode !== "on" && mode !== "off") throw new CliUsageError("Usage: ais claude-swap auto on|off [--pool=] [--threshold=95]");
        const rawThreshold = stringFlag(flags, "threshold");
        const threshold = rawThreshold === undefined ? undefined : Number(rawThreshold);
        if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 1 || threshold > 100)) {
          throw new CliUsageError("--threshold must be a number from 1 to 100");
        }
        const msg = await mutatePool(deps, poolFlag, (_file, pool) => {
          pool.swapPool.auto = mode === "on";
          if (threshold !== undefined) pool.swapPool.thresholdPercent = threshold;
          return `auto swap ${mode} for pool ${pool.name} (threshold ${pool.swapPool.thresholdPercent ?? DEFAULT_SWAP_THRESHOLD_PERCENT}%)`;
        });
        return log(`${green("✔")} ${msg}${mode === "on" ? dim(" - needs the ais console daemon (ais web start)") : ""}`);
      }

      case "pool": {
        if (rest[0] !== "create") throw new CliUsageError(USAGE);
        const name = rest[1];
        if (!name || !isValidIdentityKey(name)) throw new CliUsageError("Usage: ais claude-swap pool create <name> --accounts=a,b[,c] [--config-dir=]  (name: lowercase letters, digits, hyphens)");
        const requested = listFlag(flags, "accounts");
        if (!requested) throw new CliUsageError("Missing required --accounts=a,b[,c]");
        const file = await loadIdentitiesFile(registryPath);
        const accounts = validateMembers(file, name, requested);
        const configDir = stringFlag(flags, "config-dir") ?? join(CLAUDE_CONFIG.identitiesRootDir, name);
        const dir = translateHostPath(expandPath(configDir)); // fs form; the registry keeps the host form
        // Two pools sharing one folder would fight over its credentials.
        if (poolsOf(file).some((p) => expandPath(p.configDir) === dir) || file.identities.some((i) => expandPath(i.configDir) === dir)) {
          throw new SwapPoolError(`configDir ${dir} is already used by another identity`);
        }
        const identity = createIdentity(file, { name, label: name, description: "Claude swap pool", configDir });
        identity.swapPool = { accounts };
        await mkdir(dir, { recursive: true });
        await ensureClaudeTranscriptRetention(dir);
        await saveIdentitiesFile(registryPath, file);
        log(`${green("✔")} Created swap pool ${bold(name)} (configDir: ${configDir}; accounts: ${accounts.join(", ")}).`);
        // Secrets reach the pool only through the swap: activate the first
        // member that has a login.
        for (const account of accounts) {
          try {
            const r = await performSwap({ registryPath, ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}), pool: name, target: account, reason: "manual" });
            log(`${green("✔")} ${describeSwap(r)}`);
            return;
          } catch (err) {
            log(yellow(`  could not activate ${account}: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        log(yellow("  no member could be activated yet; log in to each account identity, then run: ais claude-swap to <account>"));
        return;
      }

      case "hook": {
        const mode = rest[0];
        if (mode !== "on" && mode !== "off") throw new CliUsageError("Usage: ais claude-swap hook on|off [--pool=]");
        const file = await loadIdentitiesFile(registryPath);
        const pool = requirePool(file, poolFlag);
        if (mode === "on") {
          await installSwapHook(pool.configDir, pool.name);
          return log(`${green("✔")} StopFailure(rate_limit) hook installed in ${join(pool.configDir, "settings.json")}`);
        }
        const removed = await removeSwapHook(pool.configDir);
        return log(removed ? `${green("✔")} hook removed` : dim("no claude-swap hook was installed"));
      }

      case "usage": {
        const days = Number(stringFlag(flags, "days") ?? 30);
        const file = await loadIdentitiesFile(registryPath);
        const pool = requirePool(file, rest[0] ?? poolFlag);
        const split = await poolMemberUsageSplit(pool, { days, ledgerPath: deps.ledgerPath ?? aisClaudeSwapLedgerPath() });
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
