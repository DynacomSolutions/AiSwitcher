import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const packagePath = process.env.HOST_PLAYWRIGHT_MODULE;
if (!packagePath) throw new Error("HOST_PLAYWRIGHT_MODULE must point to the isolated Playwright package.");
const packageRoot = packagePath.endsWith(".mjs") ? join(packagePath, "..") : packagePath;
const cli = join(packageRoot, "cli.js");
if (!existsSync(cli)) throw new Error("The isolated Playwright CLI was not found.");
const result = Bun.spawnSync(["node", cli, "test", "--config", "playwright.config.ts", ...Bun.argv.slice(2)], {
  cwd: resolve(import.meta.dir, ".."),
  env: { ...process.env, HOST_PLAYWRIGHT_MODULE: packagePath },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  timeout: 120_000,
});
if (result.exitCode === null) throw new Error("Browser smoke exceeded its 120 second limit.");
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
