import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { aisLastIdentityPath } from "../shared/ais-home.ts";

/**
 * Per-tool memory of the identity last chosen in the interactive picker.
 * Purely a convenience: every read and write swallows its errors so a missing,
 * unreadable or corrupt file can never block the picker.
 */

async function readMap(path: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [tool, name] of Object.entries(parsed)) {
      if (typeof name === "string") out[tool] = name;
    }
    return out;
  } catch {
    return {};
  }
}

export async function readLastIdentity(
  toolName: string,
  path: string = aisLastIdentityPath(),
): Promise<string | undefined> {
  try {
    return (await readMap(path))[toolName];
  } catch {
    return undefined;
  }
}

export async function writeLastIdentity(
  toolName: string,
  name: string,
  path: string = aisLastIdentityPath(),
): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const map = await readMap(path);
    map[toolName] = name;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    await unlink(tmp).catch(() => undefined);
  }
}
