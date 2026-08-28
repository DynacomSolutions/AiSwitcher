import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { boolFlag, type ParsedArgs } from "./args.ts";
import { CliUsageError } from "./errors.ts";
import { appendGlobalMemory, ensureGlobalMemoryFile } from "../shared/global-memory.ts";

async function edit(path: string): Promise<void> {
  if (!process.stdin.isTTY) throw new CliUsageError("ais memory edit requires a terminal");
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new CliUsageError("Set VISUAL or EDITOR before running ais memory edit");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: "inherit", shell: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${editor} exited ${code}`)));
  });
}

export async function runMemoryCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const [action = "show", ...entryParts] = positionals;
  const path = await ensureGlobalMemoryFile();
  switch (action) {
    case "path":
    case "init":
      console.log(path);
      return;
    case "show":
      process.stdout.write(await readFile(path, "utf8"));
      return;
    case "edit":
      await edit(path);
      return;
    case "add": {
      const entry = boolFlag(flags, "stdin")
        ? await new Response(Bun.stdin.stream()).text()
        : entryParts.join(" ");
      if (!entry.trim()) throw new CliUsageError("Usage: ais memory add <text...> or ais memory add --stdin");
      await appendGlobalMemory(entry);
      console.log(path);
      return;
    }
    default:
      throw new CliUsageError(`Unknown memory action "${action}". Use show, path, init, edit, or add.`);
  }
}
