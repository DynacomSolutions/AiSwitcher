import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { components, digest, run, smokeArchive, validateTrustKey, verifyPayload, type Target } from "./release-assets";

const repository = resolve(import.meta.dir, "../..");
const host = join(repository, "apps/host");
const targets: Record<string, { target: Target; triple: string }> = {
  "darwin-arm64": { target: "macos-arm64", triple: "aarch64-apple-darwin" },
  "win32-x64": { target: "windows-x64", triple: "x86_64-pc-windows-msvc" },
  "linux-x64": { target: "linux-x64", triple: "x86_64-unknown-linux-gnu" },
};

function notices(): string {
  const output = ["ais Host dependency notices", readFileSync(join(repository, "LICENSE"), "utf8")];
  const packages = new Map<string, string>();
  const add = (name: string, version: string, licence: string | undefined, directory: string) => {
    const texts = readdirSync(directory).filter((file) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(file))
      .filter((file) => !Bun.file(join(directory, file)).type.includes("directory"))
      .flatMap((file) => {
        try { return [readFileSync(join(directory, file), "utf8")]; } catch { return []; }
      });
    if (!licence && texts.length === 0) throw new Error(`Licence information missing for ${name}.`);
    packages.set(`${name}@${version}`, `${name}@${version}\n${licence ?? "See licence text"}\n${texts.join("\n")}`);
  };
  const metadata = JSON.parse(run(["cargo", "metadata", "--manifest-path", join(host, "Cargo.toml"), "--locked", "--format-version", "1"], host, 300_000)) as {
    packages: Array<{ name: string; version: string; license?: string; license_file?: string; manifest_path: string }>;
  };
  for (const pkg of metadata.packages) {
    add(pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path));
    if (pkg.license_file) output.push(readFileSync(resolve(dirname(pkg.manifest_path), pkg.license_file), "utf8"));
  }
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (name.startsWith(".")) continue;
      const path = join(directory, name);
      if (name.startsWith("@")) { visit(path); continue; }
      const manifest = join(path, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; version: string; license?: string };
      add(pkg.name, pkg.version, pkg.license, path);
      visit(join(path, "node_modules"));
    }
  };
  visit(join(repository, "node_modules"));
  visit(join(host, "node_modules"));
  // Bun includes its runtime notices in the official source distribution.
  output.push(run(["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "60",
    `https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`], repository));
  return [...output, ...[...packages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text)].join("\n\n");
}

if (import.meta.main) {
  const selected = targets[`${process.platform}-${process.arch}`];
  if (!selected) throw new Error("Build on a supported native runner.");
  const { target, triple } = selected;
  const production = Bun.argv.includes("--production");
  const work = process.env.HOST_BUILD_DIR;
  if (!work || !process.env.CARGO_TARGET_DIR) throw new Error("Set isolated HOST_BUILD_DIR and CARGO_TARGET_DIR.");
  const root = resolve(work);
  const resources = join(root, "resources");
  const sidecars = join(root, "sidecars");
  const assets = join(root, "assets");
  for (const directory of [resources, sidecars, assets]) mkdirSync(directory, { recursive: true });
  const keyPath = join(repository, "image/release/minisign.pub");
  const key = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : "";
  if (production) validateTrustKey(key);
  else if (!key) process.env.AIS_ALLOW_PLACEHOLDER_RELEASE_KEY = "development-only";
  const extension = process.platform === "win32" ? ".exe" : "";
  run(["cargo", "build", "--manifest-path", join(host, "Cargo.toml"), "--locked", "--release", "--target", triple,
    "-p", "ais-host-helper", "-p", "ais-host-core", "--bin", "ais-host-helper", "--bin", "ais-host-escrow-purge"], host, 2_400_000);
  const binaryDir = join(resolve(process.env.CARGO_TARGET_DIR), triple, "release");
  for (const name of ["ais-host-helper", "ais-host-escrow-purge"]) cpSync(join(binaryDir, `${name}${extension}`), join(sidecars, `${name}-${triple}${extension}`));
  run(["bun", "build", "src/host/adapter.ts", "--compile", "--outfile", join(sidecars, `ais-host-adapter-${triple}${extension}`)], repository);
  writeFileSync(join(resources, "release-key.pub"), key);
  cpSync(join(repository, "LICENSE"), join(resources, "LICENSE"));
  writeFileSync(join(resources, "THIRD-PARTY-NOTICES.txt"), notices());
  writeFileSync(join(resources, "host-build.json"), JSON.stringify({
    target, commit: process.env.GITHUB_SHA, trustKeySha256: digest(Buffer.from(key)),
    status: production ? "release-candidate" : "development-only",
    windowsSigning: "unsigned", features: ["custom-protocol"], privilegedHelper: "separate-authorised-installation",
  }, null, 2));
  const overlay = join(root, "tauri-packaging.json");
  const resourceMap = Object.fromEntries(readdirSync(resources).map((name) => [join(resources, name), name]));
  writeFileSync(overlay, JSON.stringify({
    bundle: {
      externalBin: ["ais-host-adapter", "ais-host-helper", "ais-host-escrow-purge"].map((name) => join(sidecars, name)),
      resources: resourceMap,
      macOS: { hardenedRuntime: true, minimumSystemVersion: "11.0" },
    },
  }));
  const args = ["cargo", "tauri", "build", "--target", triple, "--config", overlay];
  if (target === "windows-x64") args.push("--no-bundle");
  else args.push("--bundles", target === "macos-arm64" ? "app" : "appimage");
  args.push("--", "--locked");
  run(args, host, 2_400_000);
  let asset: string;
  if (target === "macos-arm64") {
    const app = join(binaryDir, "bundle/macos/ais Host.app");
    verifyPayload(app, target, production);
    asset = join(assets, "ais-host-macos-arm64.zip");
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, asset]);
  } else if (target === "windows-x64") {
    const portable = join(root, "portable");
    mkdirSync(portable, { recursive: true });
    for (const name of components) cpSync(name === "ais-host-app" ? join(binaryDir, `${name}.exe`) : join(sidecars, `${name}-${triple}.exe`), join(portable, `${name}.exe`));
    for (const name of readdirSync(resources)) cpSync(join(resources, name), join(portable, name));
    for (const name of readdirSync(binaryDir).filter((name) => name.endsWith(".dll"))) cpSync(join(binaryDir, name), join(portable, name));
    verifyPayload(portable, target, production);
    asset = join(assets, "ais-host-windows-x64.zip");
    run(["pwsh", "-NoProfile", "-Command", "Compress-Archive -Path (Join-Path $env:HOST_PORTABLE '*') -DestinationPath $env:HOST_ARCHIVE"], repository, 120_000,
      { ...process.env, HOST_PORTABLE: portable, HOST_ARCHIVE: asset });
  } else {
    const imageDir = join(binaryDir, "bundle/appimage");
    const images = readdirSync(imageDir).filter((name) => name.endsWith(".AppImage"));
    if (images.length !== 1) throw new Error("Expected one native AppImage.");
    asset = join(assets, "ais-host-linux-x64.AppImage");
    cpSync(join(imageDir, images[0]!), asset);
  }
  // macOS production assessment follows Developer ID signing and stapling.
  smokeArchive(asset, target, join(root, "clean launch \u00e9"), production, false);
  cpSync(join(resources, "THIRD-PARTY-NOTICES.txt"), join(assets, `THIRD-PARTY-NOTICES-${target}.txt`));
  console.log(`Packaged and smoke-tested ${target}; ${production ? "awaiting release verification" : "development-only, unsigned"}.`);
}
