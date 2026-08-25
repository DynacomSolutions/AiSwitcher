import { findIdentityByNameOrAlias } from "../../identities/store.ts";
import type { IdentitiesFile } from "../../identities/types.ts";
import { writeZaiAuthFile } from "../../identities/zai-auth.ts";
import { writeAliAuthFile } from "../../identities/ali-auth.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { dim, green } from "../colors.ts";
import { CliUsageError } from "../errors.ts";
import * as actions from "./actions.ts";
import { runChromeOverrides } from "./chrome-overrides.ts";
import { runCreate } from "./create.ts";
import { runList } from "./list.ts";
import { type LoadedFile, persist, resolveMutationTarget } from "./resolve-tool.ts";
import { runShow } from "./show.ts";

/** Load (auto-detecting or via --tool), apply a mutation, persist, and print
 * a confirmation — the shared shape behind every name-targeted mutation.
 * `apply` may return an extra note to print; it's only ever printed after
 * persist() actually succeeds, so a failed write never leaves behind a
 * reassuring message describing a change that was never saved. */
async function runNamedMutation(
  flags: ParsedArgs["flags"],
  name: string,
  apply: (file: IdentitiesFile) => { note?: string } | void,
  successMessage: (toolName: string) => string,
): Promise<void> {
  const loaded: LoadedFile = await resolveMutationTarget(flags, name);
  const result = apply(loaded.file);
  await persist(loaded);
  if (result?.note) console.log(dim(result.note));
  console.log(`${green("✔")} ${successMessage(loaded.cfg.toolName)}`);
}

export async function runIdentitiesCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const [action, ...rest] = positionals;

  switch (action ?? "list") {
    case "list":
      return runList(flags);

    case "show":
      return runShow(rest, flags);

    case "create":
      return runCreate(flags);

    case "update": {
      const name = rest[0];
      if (!name) {
        throw new CliUsageError(
          "Usage: ais identities update <name> --tool=<t> [--label=] [--description=] [--configDir=] [--api-key=]",
        );
      }
      const apiKey = stringFlag(flags, "api-key");
      await runNamedMutation(
        flags,
        name,
        (file) => {
          actions.updateIdentity(file, name, {
            label: stringFlag(flags, "label"),
            description: stringFlag(flags, "description"),
            configDir: stringFlag(flags, "configDir"),
          });
        },
        (toolName) => `Updated "${name}" in ${toolName}'s registry.`,
      );
      // --api-key isn't identities.json metadata (it's a secret, kept out of
      // the more casually viewed/backed-up registry file — see
      // identities/zai-auth.ts) so it's not threaded through actions.
      // updateIdentity/UpdateIdentityInput above; applied as its own step,
      // after the registry mutation (and any --configDir= change in the same
      // call) has already been persisted, so the key lands in the identity's
      // CURRENT configDir.
      if (apiKey !== undefined) {
        const loaded = await resolveMutationTarget(flags, name);
        if (loaded.cfg.toolName !== "zai" && loaded.cfg.toolName !== "ali") {
          throw new CliUsageError(
            `--api-key only applies to zai/ali identities (got --tool=${loaded.cfg.toolName}).`,
          );
        }
        const identity = findIdentityByNameOrAlias(loaded.file.identities, name);
        if (!identity) throw new CliUsageError(`"${name}" vanished from ${loaded.cfg.toolName}'s registry mid-update.`);
        if (loaded.cfg.toolName === "zai") {
          await writeZaiAuthFile(identity.configDir, apiKey);
          console.log(`${green("✔")} Wrote Z.ai API key to ${identity.configDir}.`);
        } else {
          await writeAliAuthFile(identity.configDir, apiKey);
          console.log(`${green("✔")} Wrote Alibaba Cloud Model Studio API key to ${identity.configDir}.`);
        }
      }
      return;
    }

    case "delete": {
      const name = rest[0];
      if (!name) throw new CliUsageError("Usage: ais identities delete <name> --tool=<t> --yes");
      if (!boolFlag(flags, "yes")) {
        throw new CliUsageError(
          `Refusing to delete "${name}" without --yes. This only removes it from the registry — ` +
            `its configDir is left untouched on disk either way.`,
        );
      }
      return runNamedMutation(
        flags,
        name,
        (file) => {
          const identity = actions.deleteIdentity(file, name);
          return { note: `Note: configDir "${identity.configDir}" was left untouched on disk.` };
        },
        (toolName) => `Deleted "${name}" from ${toolName}'s registry.`,
      );
    }

    case "add-directory": {
      const [name, pattern] = rest;
      if (!name || !pattern) {
        throw new CliUsageError("Usage: ais identities add-directory <name> <pattern> --tool=<t>");
      }
      return runNamedMutation(
        flags,
        name,
        (file) => {
          actions.addDirectory(file, name, pattern);
        },
        (toolName) => `Added directory "${pattern}" to "${name}" in ${toolName}'s registry.`,
      );
    }

    case "remove-directory": {
      const [name, pattern] = rest;
      if (!name || !pattern) {
        throw new CliUsageError("Usage: ais identities remove-directory <name> <pattern> --tool=<t>");
      }
      return runNamedMutation(
        flags,
        name,
        (file) => {
          actions.removeDirectory(file, name, pattern);
        },
        (toolName) => `Removed directory "${pattern}" from "${name}" in ${toolName}'s registry.`,
      );
    }

    case "add-alias": {
      const [name, alias] = rest;
      if (!name || !alias) throw new CliUsageError("Usage: ais identities add-alias <name> <alias> --tool=<t>");
      return runNamedMutation(
        flags,
        name,
        (file) => {
          actions.addAlias(file, name, alias);
        },
        (toolName) => `Added alias "${alias}" to "${name}" in ${toolName}'s registry.`,
      );
    }

    case "remove-alias": {
      const [name, alias] = rest;
      if (!name || !alias) throw new CliUsageError("Usage: ais identities remove-alias <name> <alias> --tool=<t>");
      return runNamedMutation(
        flags,
        name,
        (file) => {
          actions.removeAlias(file, name, alias);
        },
        (toolName) => `Removed alias "${alias}" from "${name}" in ${toolName}'s registry.`,
      );
    }

    case "chrome-overrides":
      return runChromeOverrides(rest, flags);

    default:
      throw new CliUsageError(`Unknown "ais identities" action "${action}". Run "ais help" for usage.`);
  }
}
