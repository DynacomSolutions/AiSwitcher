import { findIdentityByNameOrAlias } from "../../identities/store.ts";
import type { Identity, ToolConfig } from "../../identities/types.ts";
import type { ParsedArgs } from "../args.ts";
import { bold, dim } from "../colors.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, loadOne, toolConfigFromFlag } from "./resolve-tool.ts";

function printIdentity(cfg: ToolConfig, identity: Identity): void {
  console.log(`${bold(identity.name)}  ${dim(`(${cfg.toolName})`)}`);
  console.log(JSON.stringify(identity, null, 2));
}

export async function runShow(rest: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const name = rest[0];
  if (!name) throw new CliUsageError("Usage: ais identities show <name> [--tool=claude|codex|grok|kimi|zai]");

  const explicit = toolConfigFromFlag(flags);
  const candidates = explicit ? [await loadOne(explicit)] : await loadAll();

  let found = false;
  for (const { cfg, file } of candidates) {
    const identity = findIdentityByNameOrAlias(file.identities, name);
    if (identity) {
      printIdentity(cfg, identity);
      found = true;
    }
  }
  if (!found) {
    throw new CliUsageError(
      `No identity named "${name}" found${explicit ? ` in ${explicit.toolName}'s registry` : ""}.`,
    );
  }
}
