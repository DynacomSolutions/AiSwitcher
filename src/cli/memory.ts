import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { boolFlag, type ParsedArgs } from "./args.ts";
import { CliUsageError } from "./errors.ts";
import {
  appendedMemoryBlock,
  appendGlobalMemory,
  ensureGlobalMemoryFile,
  INITIAL_MEMORY,
} from "../shared/global-memory.ts";
import { aisGlobalMemoryPath } from "../shared/ais-home.ts";
import { addCommitMessage, detectGitBase, landMemory, type GitBaseTarget } from "../shared/memory-land.ts";

type Env = Record<string, string | undefined>;

async function runEditor(path: string): Promise<void> {
  if (!process.stdin.isTTY) throw new CliUsageError("ais memory edit requires a terminal");
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new CliUsageError("Set VISUAL or EDITOR before running ais memory edit");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: "inherit", shell: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${editor} exited ${code}`)));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function land(
  target: GitBaseTarget,
  content: string,
  message: string,
  env: Env,
  mode: "file" | "append" = "file",
): Promise<void> {
  const { result } = await landMemory(target, content, message, env, mode);
  console.log(result);
}

export async function runMemoryCommand(
  positionals: string[],
  flags: ParsedArgs["flags"],
  env: Env = process.env,
  home: string = homedir(),
): Promise<void> {
  const [action = "show", ...entryParts] = positionals;
  const memoryPath = aisGlobalMemoryPath(home);
  const target = await detectGitBase(memoryPath, env);
  const present = await exists(memoryPath);

  // Served from a git-base base checkout: never create or edit it in place.
  if (target && !present) {
    if (!["path", "init", "show", "edit", "add"].includes(action)) {
      throw new CliUsageError(`Unknown memory action "${action}". Use show, path, init, edit, or add.`);
    }
    await land(target, INITIAL_MEMORY, "docs(memory): initialise global memory", env);
  }
  const path = target ? memoryPath : await ensureGlobalMemoryFile(home);

  switch (action) {
    case "path":
      console.log(path);
      return;
    case "init":
      console.log(path);
      if (target && present) console.log("unchanged");
      return;
    case "show":
      process.stdout.write(await readFile(path, "utf8"));
      return;
    case "edit": {
      if (!target) {
        await runEditor(path);
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), "ais-memory-edit-"));
      try {
        const copy = join(dir, "GLOBAL.md");
        await copyFile(path, copy);
        const before = await readFile(copy, "utf8");
        await runEditor(copy);
        const after = await readFile(copy, "utf8");
        if (after === before) {
          console.log("unchanged");
          return;
        }
        await land(target, after, "docs(memory): edit global memory", env);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    case "add": {
      const entry = boolFlag(flags, "stdin")
        ? await new Response(Bun.stdin.stream()).text()
        : entryParts.join(" ");
      if (!entry.trim()) throw new CliUsageError("Usage: ais memory add <text...> or ais memory add --stdin");
      if (target) {
        console.log(path);
        await land(target, appendedMemoryBlock(entry), addCommitMessage(entry), env, "append");
        return;
      }
      await appendGlobalMemory(entry, home);
      console.log(path);
      return;
    }
    default:
      throw new CliUsageError(`Unknown memory action "${action}". Use show, path, init, edit, or add.`);
  }
}
