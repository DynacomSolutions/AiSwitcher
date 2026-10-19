import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = "image/build/stage-profile.sh";
const tools = ["ais", "claude", "codex", "grok", "kimi", "zai", "ali", "pi", "opencode"];

function fixture(herdr = "SYNTHETIC_FIXTURE_herdr") {
  const root = mkdtempSync(join(tmpdir(), "stage-profile-"));
  const profile = join(root, "profile");
  const stage = join(root, "stage");
  mkdirSync(join(profile, "airootfs"), { recursive: true });
  writeFileSync(join(profile, "packages.x86_64"), "base\n");
  mkdirSync(join(stage, "dist"), { recursive: true });
  for (const tool of tools) {
    writeFileSync(join(stage, "dist", tool), `#!/bin/sh\necho ${tool}\n`);
    chmodSync(join(stage, "dist", tool), 0o755);
  }
  writeFileSync(join(stage, "herdr"), herdr);
  const pins = join(root, "pins.env");
  const digest = createHash("sha256").update("SYNTHETIC_FIXTURE_herdr").digest("hex");
  writeFileSync(pins, `ARCH_ARCHIVE_DATE=2026/10/01\nHERDR_SHA256=${digest}\n`);
  return { root, profile, stage, pins };
}

function run(f: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", script, f.profile, f.stage], { env: { ...process.env, AIS_PINS_FILE: f.pins, ...env } });
}

describe("stage-profile.sh", () => {
  test("installs the helpers, tools, shims, herdr and the build time", () => {
    const f = fixture();
    try {
      const result = run(f);
      expect(result.exitCode).toBe(0);
      const air = join(f.profile, "airootfs");
      expect(statSync(join(air, "usr/local/lib/ais-live/ais-guardd")).mode & 0o111).toBeTruthy();
      expect(existsSync(join(air, "usr/local/lib/ais-live/ais_guard_policy.py"))).toBe(true);
      expect(readlinkSync(join(air, "usr/bin/ais"))).toBe("../local/bin/ais");
      expect(lstatSync(join(air, "usr/local/bin/ais")).isFile()).toBe(true);
      for (const tool of tools.slice(1)) expect(existsSync(join(air, "usr/lib/ais-live/shims", tool))).toBe(true);
      expect(readFileSync(join(air, "usr/local/bin/herdr"), "utf8")).toBe("SYNTHETIC_FIXTURE_herdr");
      expect(readFileSync(join(air, "etc/ais/image-build-time"), "utf8").trim()).toBe("2026-10-01T00:00:00Z");
      expect(readFileSync(join(f.profile, "packages.x86_64"), "utf8")).toBe("base\n");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("test packages are added only on request", () => {
    const f = fixture();
    try {
      expect(run(f, { AIS_IMAGE_TEST_PACKAGES: "1" }).exitCode).toBe(0);
      const packages = readFileSync(join(f.profile, "packages.x86_64"), "utf8").split("\n");
      expect(packages).toContain("mdadm");
      expect(packages.filter((line) => line.startsWith("#"))).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a herdr binary with the wrong digest is refused", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.stage, "herdr"), "tampered");
      const result = run(f);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("digest mismatch");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a missing compiled tool is refused", () => {
    const f = fixture();
    try {
      rmSync(join(f.stage, "dist", "pi"));
      expect(run(f).exitCode).not.toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
