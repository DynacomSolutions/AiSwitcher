import { mkdir } from "node:fs/promises";
import { sourceHashFromMetafile } from "./source-hash.ts";

const ENTRYPOINTS: Array<{ entry: string; out: string }> = [
  { entry: "src/claude.ts", out: "dist/claude" },
  { entry: "src/codex.ts", out: "dist/codex" },
  { entry: "src/grok.ts", out: "dist/grok" },
  { entry: "src/kimi.ts", out: "dist/kimi" },
  { entry: "src/zai.ts", out: "dist/zai" },
  { entry: "src/ali.ts", out: "dist/ali" },
  { entry: "src/pi.ts", out: "dist/pi" },
  // Shadows /usr/bin/open — a macOS-only concept (no equivalent bare `open`
  // command on Linux to fall back to for passthrough) — so only build/ship
  // it there. See src/open.ts.
  ...(process.platform === "darwin" ? [{ entry: "src/open.ts", out: "dist/open" }] : []),
  // The `ais` management CLI — unlike `open`, this isn't platform-gated.
  { entry: "src/ais.ts", out: "dist/ais" },
  // Fetches its sibling(s) above from the GH Release over HTTP at install
  // time rather than embedding them — see src/installer.ts.
  { entry: "src/installer.ts", out: "dist/install" },
];

export async function runBuild(): Promise<void> {
  await mkdir("dist", { recursive: true });
  for (const { entry, out } of ENTRYPOINTS) {
    console.error(`build: compiling ${entry} -> ${out}`);
    // --metafile costs nothing extra here (the bundler already computes the
    // module graph) but gives install.ts what it needs to fingerprint this
    // entrypoint's actual source inputs — see scripts/source-hash.ts.
    const proc = Bun.spawn(
      ["bun", "build", "--compile", entry, "--outfile", out, `--metafile=${out}.meta.json`],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`build: bun build --compile failed for ${entry} (exit ${exitCode})`);
    }
    // Fingerprint this build's actual source inputs RIGHT NOW, while dist/<out>
    // and its source tree are guaranteed to correspond to each other, and
    // persist it as a sidecar next to the binary — see source-hash.ts's own
    // comment for why the hash is source-content-based rather than
    // binary-bytes-based. install.ts reads this file rather than recomputing
    // the hash itself: recomputing at install time re-reads whatever's
    // CURRENTLY on disk under src/, which silently diverges from what a
    // not-yet-rebuilt dist/<out> actually contains if source was edited
    // in between (confirmed live, 2026-07-20 — see AGENTS.md).
    await Bun.write(`${out}.hash`, await sourceHashFromMetafile(`${out}.meta.json`));
  }
  console.error("build: done");
}

if (import.meta.main) {
  await runBuild();
}
