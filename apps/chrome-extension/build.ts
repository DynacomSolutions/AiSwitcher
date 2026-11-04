import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [entry, name] of [["src/background/index.ts", "background"], ["src/options/options.ts", "options"]] as const) {
  const result = await Bun.build({ entrypoints: [join(root, entry)], outdir: dist, target: "browser", format: "esm", naming: `${name}.js` });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
await cp(join(root, "src/options/options.html"), join(dist, "options.html"));
console.log("Built apps/chrome-extension/dist");
