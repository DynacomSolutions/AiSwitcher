import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_VERSION_PATTERN,
  embeddedExtensionVersion,
  installPiExtension,
  installedExtensionPath,
  resolvePiExtensionTarget,
} from "../../src/identities/pi-extension-install.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ais-pi-extension-install."));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

describe("pi extension install", () => {
  test("the embedded source carries a parseable version stamp", () => {
    expect(embeddedExtensionVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect("export const AIS_EXTENSION_VERSION = \"9.9.9\";".match(EXTENSION_VERSION_PATTERN)?.[1]).toBe("9.9.9");
  });

  test("a fresh install writes the embedded source into the identity's extensions directory", async () => {
    const root = await temporaryRoot();
    const configDir = join(root, "identity-a");
    const result = await installPiExtension(configDir);
    expect(result?.outcome).toBe("fresh");
    const path = installedExtensionPath(configDir);
    const text = await readFile(path, "utf8");
    expect(text).toContain(`AIS_EXTENSION_VERSION = "${embeddedExtensionVersion()}"`);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test("a stale version-stamped copy is replaced", async () => {
    const root = await temporaryRoot();
    const configDir = join(root, "identity-a");
    const path = installedExtensionPath(configDir);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, 'export const AIS_EXTENSION_VERSION = "0.0.1";\nexport default function () {}\n');
    const result = await installPiExtension(configDir);
    expect(result?.outcome).toBe("stale");
    expect(await readFile(path, "utf8")).toContain(`AIS_EXTENSION_VERSION = "${embeddedExtensionVersion()}"`);
  });

  test("a current copy is left untouched", async () => {
    const root = await temporaryRoot();
    const configDir = join(root, "identity-a");
    await installPiExtension(configDir);
    const path = installedExtensionPath(configDir);
    const before = await readFile(path, "utf8");
    // Disturb the mtime baseline, then reinstall: content is identical, so
    // the installer must not rewrite the file.
    const statsBefore = await stat(path);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await installPiExtension(configDir);
    expect(result?.outcome).toBe("current");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(statsBefore.mtimeMs);
  });

  test("an unwritable destination degrades to a warning instead of breaking the launch", async () => {
    const root = await temporaryRoot();
    // A FILE where a directory must be created: every mkdir/write below it
    // fails with ENOTDIR, on every user including root.
    await writeFile(join(root, "blocker"), "not a directory");
    const warnings: string[] = [];
    const result = await installPiExtension(join(root, "blocker", "identity"), { warn: (message) => warnings.push(message) });
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not install the AIS identity extension");
  });

  test("resolvePiExtensionTarget prefers the explicit dir, then the env var, then the default agent dir", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      expect(resolvePiExtensionTarget("/tmp/explicit")).toBe("/tmp/explicit");
      process.env.PI_CODING_AGENT_DIR = "/tmp/from-env";
      expect(resolvePiExtensionTarget()).toBe("/tmp/from-env");
      delete process.env.PI_CODING_AGENT_DIR;
      expect(resolvePiExtensionTarget()).toContain(".pi");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
