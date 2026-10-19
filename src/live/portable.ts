import { portableProfileCommandConfig, portableShellText } from "../sync/portable-config.ts";

const PORTABLE_JSON_NAMES = new Set(["settings.json", "hooks.json"]);

/** Canonicalise only settings fields already supported by normal SSH sync. */
export function canonicalConfig(path: string, bytes: Uint8Array): Uint8Array {
  if (path.startsWith(".ais/hooks/")) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new TextEncoder().encode(portableShellText(text));
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!PORTABLE_JSON_NAMES.has(name)) return bytes;
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(source);
  const portable = portableProfileCommandConfig(parsed);
  if (JSON.stringify(portable) === JSON.stringify(parsed)) return bytes;
  return new TextEncoder().encode(`${JSON.stringify(portable, null, 2)}\n`);
}
