// Called by build-tokscale-ais.sh once it has installed a binary: records
// which release, patches and helper built it (src/cli/usage/tokscale-build.ts).
// <inputs root> is the build's own snapshot of the helper and patch series, and
// <binary sha256> the hash of the file that build staged.
import { isAbsolute } from "node:path";
import { writeTokscaleBuildStamp } from "../src/cli/usage/tokscale-build.ts";

const [inputsRoot, binaryPath, binarySha256] = process.argv.slice(2);
if (!inputsRoot || !binaryPath || !isAbsolute(inputsRoot) || !isAbsolute(binaryPath) || !/^[0-9a-f]{64}$/.test(binarySha256 ?? "")) {
  console.error("usage: bun scripts/tokscale-stamp.ts <absolute inputs root> <absolute binary path> <binary sha256>");
  process.exit(2);
}
await writeTokscaleBuildStamp(inputsRoot, binaryPath, binarySha256);
