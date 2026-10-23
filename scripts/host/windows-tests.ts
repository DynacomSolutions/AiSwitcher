import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

// Windows test executables are compiled on Linux (cargo-xwin) and only executed on a
// Windows runner. --collect copies them, plus the binaries the integration tests spawn,
// next to a manifest; --run executes each from its crate directory, as cargo would.
type Message = {
  reason: string; executable?: string | null; manifest_path?: string;
  target?: { kind: string[]; name: string }; profile?: { test: boolean };
};
type Entry = { exe: string; crate: string };

export function parseArtifacts(lines: string[], host: string): { tests: Array<Entry & { source: string }>; bins: string[] } {
  const tests: Array<Entry & { source: string }> = [];
  const bins: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as Message;
    if (message.reason !== "compiler-artifact" || !message.executable) continue;
    if (message.profile?.test) {
      const crate = relative(host, dirname(message.manifest_path!)).replaceAll("\\", "/");
      tests.push({ source: message.executable, exe: `tests/${basename(message.executable)}`, crate });
    } else if (message.target?.kind.includes("bin")) bins.push(message.executable);
  }
  return { tests, bins };
}

if (import.meta.main) {
  const [mode, directory, host = "apps/host"] = Bun.argv.slice(2);
  if (!directory) throw new Error("Usage: windows-tests.ts --collect|--run <directory> [apps/host]");
  const root = resolve(directory);
  const hostRoot = resolve(host);
  if (mode === "--collect") {
    // cargo's JSON goes to stdin so the build output stays visible in the log.
    const { tests, bins } = parseArtifacts((await Bun.stdin.text()).split("\n"), hostRoot);
    if (tests.length === 0) throw new Error("No Windows test executables were produced.");
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    for (const test of tests) cpSync(test.source, join(root, test.exe));
    for (const bin of bins) cpSync(bin, join(root, "bin", basename(bin)));
    writeFileSync(join(root, "manifest.json"), JSON.stringify(tests.map(({ exe, crate }) => ({ exe, crate }))));
    console.log(`Collected ${tests.length} test executables and ${bins.length} binaries.`);
  } else if (mode === "--run") {
    const entries = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Entry[];
    const env = { ...process.env, AIS_TEST_BIN_DIR: join(root, "bin") };
    let failed = 0;
    for (const { exe, crate } of entries) {
      console.log(`::group::${exe} (${crate})`);
      const result = Bun.spawnSync([join(root, exe)], { cwd: join(hostRoot, crate), env, stdout: "inherit", stderr: "inherit" });
      console.log("::endgroup::");
      if (result.exitCode !== 0) { failed++; console.error(`FAILED: ${exe} exited ${result.exitCode}`); }
    }
    if (failed) throw new Error(`${failed} of ${entries.length} test executables failed.`);
    console.log(`All ${entries.length} test executables passed.`);
  } else throw new Error("Use --collect or --run.");
}
