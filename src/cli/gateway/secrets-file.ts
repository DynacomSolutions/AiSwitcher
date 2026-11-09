import { chmod, lstat, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `AIS_SECRETS_FILE` overrides the default `~/.secrets` (tests, unusual layouts). */
export const defaultSecretsPath = (): string => process.env.AIS_SECRETS_FILE || join(homedir(), ".secrets");

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

/** Every KEY=value of a shell-style secrets file, last assignment winning; empty when the file is absent. */
export async function readSecretsEntries(path = defaultSecretsPath()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const kv = parseLine(line);
    if (kv) out.set(kv.key, kv.value);
  }
  return out;
}

/** The env key holding an app's token: hyphens become underscores. */
export const appTokenKey = (app: string): string => `AIS_GATEWAY_APP_${app.toUpperCase().replace(/-/g, "_")}_TOKEN`;

/**
 * Sets KEY=value in a secrets file: backs the file up to `<path>.bak.<epoch>` first,
 * replaces an existing assignment of the key (never duplicates it) and enforces mode 0600.
 */
export async function appendSecretsFile(key: string, value: string, requested = defaultSecretsPath(), epoch = Math.floor(Date.now() / 1000)): Promise<void> {
  await rewriteSecrets(requested, epoch, (kept) => {
    kept.push(`${key}=${value}`);
  }, key, true);
}

/** Removes KEY from a secrets file (backup first, mode 0600); a missing file or key is a no-op. */
export async function removeSecretsKey(key: string, requested = defaultSecretsPath(), epoch = Math.floor(Date.now() / 1000)): Promise<void> {
  await rewriteSecrets(requested, epoch, () => {}, key, false);
}

async function rewriteSecrets(requested: string, epoch: number, edit: (kept: string[]) => void, key: string, createIfMissing: boolean): Promise<void> {
  // A symlinked secrets file is updated in place at its target.
  let path = requested;
  try {
    path = await realpath(requested);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // ENOENT is either a missing file or a dangling symlink; the link must not be replaced.
    const st = await lstat(requested).catch(() => undefined);
    if (st?.isSymbolicLink()) throw new Error(`${requested} is a dangling symlink; refusing to replace it`);
  }
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (e) {
    // Only a missing file is "absent"; any other error must not lead to replacing the file.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!createIfMissing && (existing === undefined || !existing.split("\n").some((line) => parseLine(line)?.key === key))) return;
  if (existing !== undefined) {
    for (let n = 0; ; n++) {
      const backup = n === 0 ? `${path}.bak.${epoch}` : `${path}.bak.${epoch}.${n}`;
      try {
        await writeFile(backup, existing, { mode: 0o600, flag: "wx" });
        await chmod(backup, 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }
  const kept = (existing ?? "").split("\n").filter((line) => parseLine(line)?.key !== key);
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  edit(kept);
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(`${kept.join("\n")}\n`);
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
