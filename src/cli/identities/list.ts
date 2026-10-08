import type { IdentitiesFile, Identity, ToolConfig } from "../../identities/types.ts";
import type { ParsedArgs } from "../args.ts";
import { isRetired } from "../../identities/retired.ts";
import { bold, dim, gray, green, yellow } from "../colors.ts";
import { TOOL_CONFIGS, loadOne, toolConfigFromFlag } from "./resolve-tool.ts";

const BRANCH = "├── ";
const BRANCH_LAST = "└── ";
const PIPE = "│   ";
const BLANK = "    ";
// Same width as BRANCH/BRANCH_LAST, so a field's key lines up under the
// profile name's own column instead of the tree glyph.
const FIELD_INDENT = "    ";

function identityFields(identity: Identity): Array<[string, string[]]> {
  const fields: Array<[string, string[]]> = [];
  if (identity.aliases?.length) fields.push(["aliases", identity.aliases]);
  fields.push(["configDir", [identity.configDir]]);
  if (identity.colour !== undefined) fields.push(["colour", [identity.colour]]);
  if (identity.directories?.length) fields.push(["directories", identity.directories]);
  if (identity.retiredAt !== undefined) fields.push(["retiredAt", [identity.retiredAt]]);
  return fields;
}

// The profile itself is the tree's leaf (├──/└──); its config fields hang
// off it as plain indented lines with no branch chars of their own. A
// field's later values (e.g. multiple directories) line up under its first
// value's column, not under the label, so they read as one aligned list
// instead of trailing off after a comma-separated run.
function formatIdentity(identity: Identity, isLast: boolean): string {
  const continuation = isLast ? BLANK : PIPE;
  const retired = isRetired(identity) ? `  ${dim("(retired)")}` : "";
  const lines = [`${isLast ? BRANCH_LAST : BRANCH}${bold(identity.name)}  ${dim(`(${identity.label})`)}${retired}`];
  for (const [key, values] of identityFields(identity)) {
    lines.push(`${continuation}${FIELD_INDENT}${gray(key)}: ${values[0]}`);
    const padding = " ".repeat(key.length + 2);
    for (const value of values.slice(1)) {
      lines.push(`${continuation}${FIELD_INDENT}${padding}${value}`);
    }
  }
  return lines.join("\n");
}

/** Retired identities last; otherwise the registry's own order is kept. */
export function sortRetiredLast(identities: Identity[]): Identity[] {
  return [...identities.filter((i) => !isRetired(i)), ...identities.filter(isRetired)];
}

type PoolIdentity = Identity & { swapPool: NonNullable<Identity["swapPool"]> };

function isPool(identity: Identity): identity is PoolIdentity {
  return identity.swapPool !== undefined;
}

function isAllowed(pool: PoolIdentity, account: string): boolean {
  return !(pool.swapPool.disallowed ?? []).includes(account);
}

/** Pads `text` (plain, uncoloured) to `width`. */
function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

/**
 * One block per claude pool, kept apart from the identity tree: a pool
 * is a shared Claude folder whose grant is swapped between member accounts,
 * not an identity of its own. Lists every member with its active and allowed
 * state, from the registry alone (no network).
 */
export function formatSwapPool(file: IdentitiesFile, pool: PoolIdentity): string[] {
  const retired = isRetired(pool) ? `  ${dim("(retired)")}` : "";
  const lines = [`${bold(pool.name)}  ${dim(`(${pool.label})`)}${retired}`];
  lines.push(`${FIELD_INDENT}${gray("configDir")}: ${pool.configDir}`);
  const rows = pool.swapPool.accounts.map((account) => {
    const member = file.identities.find((i) => i.name === account);
    return {
      account,
      label: member ? member.label : "(missing from registry)",
      active: pool.swapPool.active === account,
      allowed: isAllowed(pool, account),
    };
  });
  const nameW = Math.max("account".length, ...rows.map((r) => r.account.length));
  const labelW = Math.max("label".length, ...rows.map((r) => r.label.length));
  lines.push(`${FIELD_INDENT}${gray(`  ${pad("account", nameW)}  ${pad("label", labelW)}  allowed`)}`);
  for (const row of rows) {
    const marker = row.active ? green("*") : " ";
    const allowed = row.allowed ? "yes" : yellow("no (disallowed)");
    const name = row.active ? bold(pad(row.account, nameW)) : pad(row.account, nameW);
    lines.push(`${FIELD_INDENT}${marker} ${name}  ${dim(pad(row.label, labelW))}  ${allowed}${row.active ? `  ${green("active")}` : ""}`);
  }
  return lines;
}

export async function printRegistry(cfg: ToolConfig): Promise<void> {
  const { file } = await loadOne(cfg);
  console.log(`${bold(cfg.toolName)} ${dim(`(${cfg.identitiesJsonPath})`)}`);
  const pools = file.identities.filter(isPool);
  const normal = file.identities.filter((i) => !isPool(i));
  if (!normal.length) {
    console.log(`${BRANCH_LAST}${dim("(no identities configured)")}`);
  }
  const identities = sortRetiredLast(normal);
  identities.forEach((identity, i) => {
    console.log(formatIdentity(identity, i === identities.length - 1));
  });
  if (!pools.length) return;
  console.log("");
  console.log(`${bold(`${cfg.toolName} pools`)} ${dim("(not identities)")}`);
  pools.forEach((pool, i) => {
    if (i > 0) console.log("");
    for (const line of formatSwapPool(file, pool)) console.log(line);
  });
}

export async function runList(flags: ParsedArgs["flags"]): Promise<void> {
  const cfg = toolConfigFromFlag(flags);
  const targets = cfg ? [cfg] : Object.values(TOOL_CONFIGS);
  for (const [i, target] of targets.entries()) {
    if (i > 0) console.log("");
    await printRegistry(target);
  }
}
