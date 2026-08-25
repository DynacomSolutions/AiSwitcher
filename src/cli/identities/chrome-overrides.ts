import type { ChromeProfileOverride, ToolConfig } from "../../identities/types.ts";
import { listFlag, requireFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { bold, cyan, dim, green } from "../colors.ts";
import { CliUsageError } from "../errors.ts";
import { addChromeOverride, removeChromeOverride } from "./actions.ts";
import { TOOL_CONFIGS, loadOne, persist, requireToolConfigFromFlag, toolConfigFromFlag } from "./resolve-tool.ts";

function formatOverride(index: number, o: ChromeProfileOverride): string {
  const label = o.label ? ` ${dim(`(${o.label})`)}` : "";
  return `  ${cyan(`[${index}]`)} ${o.directories.join(", ")} ${dim("->")} ${bold(o.targetIdentity)}${label}`;
}

async function printOverrides(cfg: ToolConfig): Promise<void> {
  const { file } = await loadOne(cfg);
  const overrides = file.chromeProfileOverrides ?? [];
  console.log(`${bold(cfg.toolName)} ${dim(`(${cfg.identitiesJsonPath})`)}:`);
  console.log(overrides.length ? overrides.map((o, i) => formatOverride(i, o)).join("\n") : dim("  (none configured)"));
}

async function runList(flags: ParsedArgs["flags"]): Promise<void> {
  const cfg = toolConfigFromFlag(flags);
  const targets = cfg ? [cfg] : Object.values(TOOL_CONFIGS);
  for (const [i, target] of targets.entries()) {
    if (i > 0) console.log("");
    await printOverrides(target);
  }
}

async function runAdd(flags: ParsedArgs["flags"]): Promise<void> {
  const cfg = requireToolConfigFromFlag(flags);
  const directories = listFlag(flags, "directories");
  if (!directories?.length) {
    throw new CliUsageError(
      "Usage: ais identities chrome-overrides add --tool=<t> --directories=a,b --target-identity=<name> [--label=]",
    );
  }
  const targetIdentity = requireFlag(flags, "target-identity");
  const label = stringFlag(flags, "label");

  const loaded = await loadOne(cfg);
  addChromeOverride(loaded.file, { directories, targetIdentity, ...(label ? { label } : {}) });
  await persist(loaded);
  console.log(`${green("✔")} Added chrome-overrides entry for [${directories.join(", ")}] in ${cfg.toolName}'s registry.`);
}

async function runRemove(rest: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const cfg = requireToolConfigFromFlag(flags);
  const indexRaw = rest[0];
  if (!indexRaw) {
    throw new CliUsageError("Usage: ais identities chrome-overrides remove --tool=<t> <index>");
  }

  const loaded = await loadOne(cfg);
  const removed = removeChromeOverride(loaded.file, Number(indexRaw));
  await persist(loaded);
  console.log(
    `${green("✔")} Removed chrome-overrides entry [${removed.directories.join(", ")} -> ${removed.targetIdentity}] from ${cfg.toolName}'s registry.`,
  );
}

export async function runChromeOverrides(rest: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const [action, ...actionRest] = rest;
  switch (action) {
    case "list":
    case undefined:
      return runList(flags);
    case "add":
      return runAdd(flags);
    case "remove":
      return runRemove(actionRest, flags);
    default:
      throw new CliUsageError(`Unknown "ais identities chrome-overrides" action "${action}".`);
  }
}
