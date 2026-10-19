import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url);
const validator = new URL("image/lib/ais_live_model_validate.py", root).pathname;
const python = String.raw`
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ais_live_model_validate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.validate(sys.argv[2], sys.argv[3], os.getuid(), os.getuid())
`;

async function makeFixture(base: string, content: string) {
  const source = join(base, "models");
  const home = join(base, "agent-home");
  await mkdir(source);
  await mkdir(home, { mode: 0o700 });
  const bytes = Buffer.from(content);
  await writeFile(join(source, "small.gguf"), bytes);
  await writeFile(join(source, "manifest.json"), JSON.stringify({ files: [{
    file: "small.gguf", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
  }] }));
  return { source, home };
}

function validate(source: string, home: string) {
  return spawnSync("python3", ["-B", "-c", python, validator, source, home], { encoding: "utf8" });
}

describe("exchange model validation", () => {
  it("accepts a verified model and rejects a bad digest before mounting", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-model-valid-"));
    try {
      const fixture = await makeFixture(base, "synthetic model bytes");
      expect(validate(fixture.source, fixture.home).status).toBe(0);
      expect((await readFile(join(fixture.home, ".ais-live-model-cache", "manifest.json"), "utf8"))).toContain("manifestSha256");
      await rm(join(fixture.home, ".ais-live-model-cache"), { recursive: true });
      await writeFile(join(fixture.source, "small.gguf"), "synthetic model bytex");
      expect(validate(fixture.source, fixture.home).status).not.toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects unlisted files, symlink models, and writable cache directories", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-model-reject-"));
    try {
      await mkdir(join(base, "unlisted"));
      const unlisted = await makeFixture(join(base, "unlisted"), "fixture");
      await writeFile(join(unlisted.source, "unexpected.gguf"), "not in manifest");
      expect(validate(unlisted.source, unlisted.home).status).not.toBe(0);

      await mkdir(join(base, "linked"));
      const linked = await makeFixture(join(base, "linked"), "fixture");
      await rm(join(linked.source, "small.gguf"));
      await symlink(join(base, "outside"), join(linked.source, "small.gguf"));
      await writeFile(join(base, "outside"), "fixture");
      expect(validate(linked.source, linked.home).status).not.toBe(0);

      await mkdir(join(base, "hostile"));
      const hostile = await makeFixture(join(base, "hostile"), "fixture");
      await mkdir(join(hostile.home, ".ais-live-model-cache"), { mode: 0o777 });
      expect(validate(hostile.source, hostile.home).status).not.toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
