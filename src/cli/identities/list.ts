import type { Identity, ToolConfig } from "../../identities/types.ts";
import type { ParsedArgs } from "../args.ts";
import { bold, dim, gray } from "../colors.ts";
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
  if (identity.directories?.length) fields.push(["directories", identity.directories]);
  return fields;
}

// The profile itself is the tree's leaf (├──/└──); its config fields hang
// off it as plain indented lines with no branch chars of their own. A
// field's later values (e.g. multiple directories) line up under its first
// value's column, not under the label, so they read as one aligned list
// instead of trailing off after a comma-separated run.
function formatIdentity(identity: Identity, isLast: boolean): string {
  const continuation = isLast ? BLANK : PIPE;
  const lines = [`${isLast ? BRANCH_LAST : BRANCH}${bold(identity.name)}  ${dim(`(${identity.label})`)}`];
  for (const [key, values] of identityFields(identity)) {
    lines.push(`${continuation}${FIELD_INDENT}${gray(key)}: ${values[0]}`);
    const padding = " ".repeat(key.length + 2);
    for (const value of values.slice(1)) {
      lines.push(`${continuation}${FIELD_INDENT}${padding}${value}`);
    }
  }
  return lines.join("\n");
}

async function printRegistry(cfg: ToolConfig): Promise<void> {
  const { file } = await loadOne(cfg);
  console.log(`${bold(cfg.toolName)} ${dim(`(${cfg.identitiesJsonPath})`)}`);
  if (!file.identities.length) {
    console.log(`${BRANCH_LAST}${dim("(no identities configured)")}`);
    return;
  }
  file.identities.forEach((identity, i) => {
    console.log(formatIdentity(identity, i === file.identities.length - 1));
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
