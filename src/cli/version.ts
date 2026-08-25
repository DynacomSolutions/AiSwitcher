import pkg from "../../package.json" with { type: "json" };

/** package.json's version is the single source of truth — bump it alongside
 * each release tag so this stays meaningful (see README). Bun's bundler
 * embeds this JSON import directly into the `--compile` binary, so no
 * separate build-time version stamp is needed. */
export function runVersion(): void {
  console.log(pkg.version);
}
