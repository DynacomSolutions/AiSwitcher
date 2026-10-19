import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const entry = resolve(repository, "src/host/adapter.ts");
if (!existsSync(entry)) {
  throw new Error("The host adapter entrypoint is not present yet.");
}
const output = resolve(repository, "apps/host/dist/adapter/ais-host-adapter");
const result = Bun.spawnSync(["bun", "build", entry, "--compile", "--outfile", output], {
  cwd: repository,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  timeout: 120_000,
});
if (result.exitCode === null) throw new Error("Host adapter compilation exceeded its 120 second limit.");
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
