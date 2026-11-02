import { chmod, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultSecretsPath = (): string => join(homedir(), ".secrets");

/** Strips an optional `export ` prefix and surrounding quotes from one KEY=value line. */
function parseLine(line: string): { key: string; value: string } | undefined {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!m) return undefined;
  let value = (m[2] ?? "").trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
  return { key: m[1]!, value };
}

/** Reads one key from a shell-style secrets file; undefined when the file or key is absent. */
export async function readSecretsKey(key: string, path = defaultSecretsPath()): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const kv = parseLine(line);
    if (kv?.key === key) found = kv.value;
  }
  return found;
}

/** The env key holding an app's token: hyphens become underscores. */
export const appTokenKey = (app: string): string => `AIS_GATEWAY_APP_${app.toUpperCase().replace(/-/g, "_")}_TOKEN`;

/**
 * Sets KEY=value in a secrets file: backs the file up to `<path>.bak.<epoch>` first,
 * replaces an existing assignment of the key (never duplicates it) and enforces mode 0600.
 */
export async function appendSecretsFile(key: string, value: string, path = defaultSecretsPath(), epoch = Math.floor(Date.now() / 1000)): Promise<void> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    const backup = `${path}.bak.${epoch}`;
    await copyFile(path, backup);
    await chmod(backup, 0o600);
  }
  const kept = (existing ?? "").split("\n").filter((line) => parseLine(line)?.key !== key);
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  kept.push(`${key}=${value}`);
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
