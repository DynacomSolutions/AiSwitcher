import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { encodeJsonFrame } from "../../src/host/protocol";

export type Target = "macos-arm64" | "windows-x64" | "linux-x64";
export const components = ["ais-host-app", "ais-host-adapter", "ais-host-helper", "ais-host-escrow-purge"];
export const releaseFiles = ["ais-host-macos-arm64.zip", "ais-host-windows-x64.zip", "ais-host-windows-x64-setup.exe", "ais-host-linux-x64.AppImage",
  ...["macos-arm64", "windows-x64", "linux-x64"].map((target) => `THIRD-PARTY-NOTICES-${target}.txt`)];
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function binaryTarget(bytes: Buffer): Target {
  if (bytes.length >= 64 && bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) && bytes.readUInt16LE(18) === 62) return "linux-x64";
  if (bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c) return "macos-arm64";
  if (bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(60);
    if (offset <= bytes.length - 6 && bytes.toString("ascii", offset, offset + 4) === "PE\0\0" && bytes.readUInt16LE(offset + 4) === 0x8664) return "windows-x64";
  }
  throw new Error("Unexpected executable format or architecture.");
}

export function validateTrustKey(key: string): void {
  const lines = key.trim().split(/\r?\n/);
  const encoded = lines.at(-1) ?? "";
  const packet = Buffer.from(encoded, "base64");
  if (/placeholder|SYNTHETIC_FIXTURE/i.test(key) || !/^[A-Za-z0-9+/]{56}$/.test(encoded)
    || packet.length !== 42 || !["Ed", "ED"].includes(packet.toString("ascii", 0, 2))) {
    throw new Error("A reviewed minisign image trust key is required for production.");
  }
}

export function validatePayloadNames(paths: string[], target: Target): void {
  if (paths.some((path) => path.split(/[\\/]/).includes("..") || /(?:host-file-check|bundle-bridge|fixture|credentials|\.p12$|\.p8$|\.keychain)/i.test(path))) {
    throw new Error("Unsafe or development-only release payload.");
  }
  const names = paths.map((path) => basename(path));
  for (const name of [...components.map((name) => `${name}${target === "windows-x64" ? ".exe" : ""}`), "release-key.pub", "THIRD-PARTY-NOTICES.txt", "LICENSE", "host-build.json"]) {
    if (names.filter((entry) => entry === name).length !== 1) throw new Error(`Missing or duplicate release component: ${name}`);
  }
}

export function checksums(files: Array<{ name: string; bytes: Uint8Array }>): string {
  const names = new Set<string>();
  return files.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, bytes }) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || names.has(name)) throw new Error("Ambiguous checksum filename.");
    names.add(name);
    return `${digest(bytes)}  ${name}\n`;
  }).join("");
}

export function run(command: string[], cwd = process.cwd(), timeout = 120_000, env = process.env): string {
  const result = Bun.spawnSync(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error(`${basename(command[0]!)} failed or exceeded its time limit.\n${result.stderr.toString().slice(-4000)}`);
  return result.stdout.toString();
}

export function payloadFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const dest = realpathSync(path);
        if (dest !== root && !dest.startsWith(`${resolve(root)}${sep}`)) throw new Error("Release symlink escapes its package.");
      } else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) result.push(relative(root, path));
      else throw new Error("Unexpected release file type.");
    }
  };
  walk(root);
  return result;
}

function pinnedKey(): string {
  const path = resolve(import.meta.dir, "../../image/release/minisign.pub");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function verifyPayload(root: string, target: Target, production: boolean, expectedKey = pinnedKey()): void {
  const files = payloadFiles(root);
  validatePayloadNames(files, target);
  for (const name of components) {
    const path = files.find((path) => basename(path) === `${name}${target === "windows-x64" ? ".exe" : ""}`)!;
    const bytes = readFileSync(join(root, path));
    if (binaryTarget(bytes) !== target) throw new Error(`Incorrect architecture: ${name}`);
    if (bytes.includes(Buffer.from("SYNTHETIC_FIXTURE"))) throw new Error(`Synthetic fixture data in ${name}.`);
  }
  const key = readFileSync(join(root, files.find((path) => basename(path) === "release-key.pub")!), "utf8");
  if (production) validateTrustKey(key);
  if (key !== expectedKey) throw new Error("Packaged image trust key differs from the pinned source.");
  const metadata = JSON.parse(readFileSync(join(root, files.find((path) => basename(path) === "host-build.json")!), "utf8")) as Record<string, unknown>;
  if (metadata.target !== target || metadata.trustKeySha256 !== digest(Buffer.from(key))
    || metadata.status !== (production ? "release-candidate" : "development-only")
    || metadata.windowsSigning !== "unsigned" || JSON.stringify(metadata.features) !== '["custom-protocol"]'
    || metadata.privilegedHelper !== "separate-authorised-installation") throw new Error("Incorrect release metadata or enabled test features.");
  if (production && (!/^[a-f0-9]{40}$/.test(String(metadata.commit)) || metadata.commit !== process.env.GITHUB_SHA)) {
    throw new Error("Packaged source commit differs from the checked release commit.");
  }
  for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
    const path = files.find((path) => basename(path) === name)!;
    if (readFileSync(join(root, path)).length < 100) throw new Error("Missing licence notices.");
  }
}

function option(name: string): string | undefined {
  return Bun.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function verifyChecksums(directory: string): void {
  const lines = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n");
  const names = new Set<string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || names.has(match[2]!) || digest(readFileSync(join(directory, match[2]!))) !== match[1]) throw new Error("Distributed checksum verification failed.");
    names.add(match[2]!);
  }
  if (names.size === 0) throw new Error("Empty checksum manifest.");
  if (names.size !== releaseFiles.length || releaseFiles.some((name) => !names.has(name))) throw new Error("Missing or unexpected release asset.");
  for (const name of readdirSync(directory)) if (name !== "SHA256SUMS" && !names.has(name)) throw new Error("Unlisted release asset.");
}

// Exercise the distributed bytes from a fresh path, without FUSE or a writable
// application directory. State stays under the caller's isolated user-data roots.
export function smokeArchive(asset: string, target: Target, destination: string, production: boolean, assessMac = production): void {
  if (existsSync(destination)) throw new Error("Smoke destination must be fresh.");
  mkdirSync(destination, { recursive: true });
  let payload = destination;
  let app: string;
  if (target === "macos-arm64") {
    run(["ditto", "-x", "-k", resolve(asset), destination]);
    app = join(destination, "ais Host.app");
    payload = app;
    if (assessMac) {
      for (const command of [
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", app],
        ["spctl", "--assess", "--type", "execute", "--verbose=2", app],
        ["xcrun", "stapler", "validate", app],
      ]) run(command);
    }
  } else if (target === "windows-x64") {
    payload = join(destination, "portable");
    // Paths are passed as environment data, never interpolated into PowerShell.
    run(["pwsh", "-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:HOST_ARCHIVE -DestinationPath $env:HOST_EXTRACT"], process.cwd(), 120_000,
      { ...process.env, HOST_ARCHIVE: resolve(asset), HOST_EXTRACT: payload });
    app = join(payload, "ais-host-app.exe");
  } else {
    const image = join(destination, "host.AppImage");
    cpSync(asset, image);
    chmodSync(image, 0o755);
    run([image, "--appimage-extract"], destination);
    payload = join(destination, "squashfs-root");
    app = join(payload, "AppRun");
  }
  verifyPayload(payload, target, production);
  const original = payloadFiles(payload).map((path) => [path, digest(readFileSync(join(payload, path)))] as const);
  if (target === "linux-x64") run(["chmod", "-R", "a-w", payload]);
  // A capabilities round trip exercises the shipped adapter without reading
  // identities, credentials or devices.
  const adapter = join(payload, original.find(([path]) => basename(path) === `ais-host-adapter${target === "windows-x64" ? ".exe" : ""}`)![0]);
  const data = join(destination, "user-data");
  mkdirSync(data);
  const env = { ...process.env, XDG_DATA_HOME: data, XDG_CONFIG_HOME: data, XDG_CACHE_HOME: data,
    ...(target === "windows-x64" ? { APPDATA: data, LOCALAPPDATA: data } : {}) };
  const probe = Bun.spawnSync([adapter], { cwd: dirname(adapter), env, stdin: encodeJsonFrame({ version: 1, operation: "capabilities", payloadBytes: 0 }),
    stdout: "pipe", stderr: "pipe", timeout: 15_000, maxBuffer: 64 * 1024 });
  if (probe.exitCode !== 0 || probe.stdout.length < 4 || probe.stdout.readUInt32BE(0) !== probe.stdout.length - 4) {
    throw new Error("Packaged adapter capabilities probe failed.");
  }
  const capabilities = JSON.parse(probe.stdout.subarray(4).toString()) as { version?: number; ok?: boolean; payloadBytes?: number; result?: { protocolVersion?: number } };
  if (capabilities.version !== 1 || capabilities.ok !== true || capabilities.payloadBytes !== 0 || capabilities.result?.protocolVersion !== 1) {
    throw new Error("Packaged adapter protocol mismatch.");
  }
  run(["bun", "run", "scripts/host/native-smoke.ts", "--case=packaged", `--app=${app}`], process.cwd(), 60_000, env);
  const after = payloadFiles(payload);
  if (JSON.stringify(after.sort()) !== JSON.stringify(original.map(([path]) => path).sort())) throw new Error("Native smoke changed its package file list.");
  for (const [path, hash] of original) if (digest(readFileSync(join(payload, path))) !== hash) throw new Error("Native smoke modified its application package.");
  if (target === "macos-arm64" && assessMac) run(["codesign", "--verify", "--deep", "--strict", app]);
}

if (import.meta.main) {
  const directory = resolve(option("dir") ?? process.env.HOST_RELEASE_DIR ?? "dist/host-release");
  if (Bun.argv.includes("--checksums")) {
    const files = readdirSync(directory).filter((name) => name !== "SHA256SUMS");
    writeFileSync(join(directory, "SHA256SUMS"), checksums(files.map((name) => ({ name, bytes: readFileSync(join(directory, name)) }))));
  } else if (Bun.argv.includes("--verify")) verifyChecksums(directory);
  else if (Bun.argv.includes("--smoke")) {
    const target = option("target") as Target;
    if (!["macos-arm64", "windows-x64", "linux-x64"].includes(target)) throw new Error("Unknown release target.");
    const asset = option("asset");
    const destination = option("destination");
    if (!asset || !destination) throw new Error("Smoke needs an asset and a fresh destination.");
    smokeArchive(asset, target, resolve(destination), Bun.argv.includes("--production"));
  } else throw new Error("Use --checksums, --verify or --smoke.");
}
