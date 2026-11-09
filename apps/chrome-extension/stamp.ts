/** Stamps the real AIS version into the extension manifest. */

/** Chrome accepts 1-4 dot-separated integers (0-65535) in `version`; a prerelease or build suffix goes in `version_name`. */
export function stampManifest(manifest: Record<string, unknown>, aisVersion: string): Record<string, unknown> {
  const m = /^(\d+(?:\.\d+){0,3})(?=$|[-+])/.exec(aisVersion.trim());
  if (!m || m[1]!.split(".").some((n) => Number(n) > 65535)) throw new Error(`Cannot derive a Chrome extension version from "${aisVersion}"`);
  const out: Record<string, unknown> = { ...manifest, version: m[1] };
  if (m[1] !== aisVersion.trim()) out.version_name = aisVersion.trim();
  else delete out.version_name;
  return out;
}
