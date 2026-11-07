// Called by build-tokscale-ais.sh once it has installed a binary: records
// which release, patches and helper built it (src/cli/usage/tokscale-build.ts).
import { isAbsolute } from "node:path";
import { writeTokscaleBuildStamp } from "../src/cli/usage/tokscale-build.ts";

const [repoRoot, binaryPath] = process.argv.slice(2);
if (!repoRoot || !binaryPath || !isAbsolute(repoRoot) || !isAbsolute(binaryPath)) {
  console.error("usage: bun scripts/tokscale-stamp.ts <absolute repo root> <absolute binary path>");
  process.exit(2);
}
await writeTokscaleBuildStamp(repoRoot, binaryPath);
