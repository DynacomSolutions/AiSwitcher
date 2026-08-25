import { createHash } from "node:crypto";

/**
 * A per-entrypoint content fingerprint derived from `bun build`'s
 * `--metafile` module graph — NOT the compiled binary's own bytes.
 * `bun build --compile` embeds a fresh build id into the standalone
 * executable on every invocation (verified empirically: two back-to-back
 * compiles of byte-identical source produce byte-different binaries), so
 * hashing the binary itself would always read as "changed" and defeat the
 * whole point. Hashing the actual source files an entrypoint transitively
 * imports is what lets independent binaries version independently — a
 * change under src/cli/* touches ais's hash but not claude's/codex's, since
 * neither imports from cli/* (confirmed via the metafile's own input list).
 *
 * Called ONLY from build.ts, immediately after compiling — never from
 * install.ts. This function re-reads its input files' CURRENT content from
 * disk, so calling it later (e.g. at install time) against a possibly-stale
 * dist/<name> would fingerprint whatever's on disk NOW, not what actually
 * went into that binary — see build.ts's own comment for the real bug this
 * caused (2026-07-20). build.ts persists the result as dist/<name>.hash;
 * install.ts just reads that sidecar back.
 */
export async function sourceHashFromMetafile(metafilePath: string): Promise<string> {
  const meta = (await Bun.file(metafilePath).json()) as { inputs: Record<string, unknown> };
  const paths = Object.keys(meta.inputs).sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  }
  return hash.digest("hex");
}
