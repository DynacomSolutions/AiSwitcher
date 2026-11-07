import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
// Optional output directory (the e2e builds into its own per-run directory).
const dist = process.argv[2] ?? join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// The content script is injected as a classic script, so it is bundled as an IIFE.
const entries = [
  ["src/background/index.ts", "background", "esm"],
  ["src/sidepanel/sidepanel.ts", "sidepanel", "esm"],
  ["src/content/index.ts", "content", "iife"],
] as const;
for (const [entry, name, format] of entries) {
  const result = await Bun.build({ entrypoints: [join(root, entry)], outdir: dist, target: "browser", format, naming: `${name}.js`, define: { AIS_E2E: process.env.AIS_E2E === "1" ? "true" : "false" } });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
await cp(join(root, "src/sidepanel/sidepanel.html"), join(dist, "sidepanel.html"));
await cp(join(root, "src/sidepanel/sidepanel.css"), join(dist, "sidepanel.css"));
console.log(`Built ${process.argv[2] ?? "apps/chrome-extension/dist"}`);
