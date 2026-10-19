import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
const stagePython = String.raw`
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ais_live_model_validate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.stage_verified(sys.argv[2], sys.argv[3], sys.argv[4], os.getuid(), os.getuid())
`;
const cachedTamperStagePython = String.raw`
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ais_live_model_validate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source, destination, home = sys.argv[2:5]
module.validate(source, home, os.getuid(), os.getuid())
path = os.path.join(source, "small.gguf")
before = os.stat(path)
with open(path, "wb") as stream: stream.write(b"synthetic model bytex")
os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
after = os.stat(path)
assert before.st_size == after.st_size
assert before.st_mtime_ns == after.st_mtime_ns
try:
    module.stage_verified(source, destination, home, os.getuid(), os.getuid())
except ValueError:
    if os.path.lexists(destination): raise AssertionError("failed staging was published")
else:
    raise AssertionError("changed bytes passed staging")
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
  it("validates copied staged bytes and publishes root-readable modes from restrictive source files", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-model-stage-"));
    try {
      const fixture = await makeFixture(base, "synthetic staged model bytes");
      await chmod(fixture.source, 0o700);
      await chmod(join(fixture.source, "small.gguf"), 0o600);
      await chmod(join(fixture.source, "manifest.json"), 0o600);
      const stage = join(base, "stage");
      const home = join(base, "root-home");
      await mkdir(home, { mode: 0o700 });
      const staged = spawnSync("python3", ["-B", "-c", stagePython, validator, fixture.source, stage, home], { encoding: "utf8" });
      expect(staged.status, staged.stderr).toBe(0);
      const sourceBytes = await readFile(join(fixture.source, "small.gguf"));
      const stagedBytes = await readFile(join(stage, "small.gguf"));
      expect(createHash("sha256").update(stagedBytes).digest("hex")).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
      expect(validate(stage, home).status).toBe(0);
      expect((await stat(fixture.source)).mode & 0o777).toBe(0o700);
      expect((await stat(join(fixture.source, "small.gguf"))).mode & 0o777).toBe(0o600);
      expect((await stat(stage)).mode & 0o777).toBe(0o755);
      expect((await stat(join(stage, "small.gguf"))).mode & 0o777).toBe(0o644);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

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

  it("rejects changed bytes with preserved size and mtime despite a prior cache entry", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-model-cache-tamper-"));
    try {
      const fixture = await makeFixture(base, "synthetic model bytes");
      const stage = join(base, "failed-stage");
      const result = spawnSync("python3", ["-B", "-c", cachedTamperStagePython, validator, fixture.source, stage, fixture.home], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      await expect(stat(stage)).rejects.toThrow();
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
      const unlistedStage = join(base, "unlisted-stage");
      expect(spawnSync("python3", ["-B", "-c", stagePython, validator, unlisted.source, unlistedStage, unlisted.home], { encoding: "utf8" }).status).not.toBe(0);
      await expect(stat(unlistedStage)).rejects.toThrow();

      await mkdir(join(base, "linked"));
      const linked = await makeFixture(join(base, "linked"), "fixture");
      await rm(join(linked.source, "small.gguf"));
      await symlink(join(base, "outside"), join(linked.source, "small.gguf"));
      await writeFile(join(base, "outside"), "fixture");
      expect(validate(linked.source, linked.home).status).not.toBe(0);
      const linkedStage = join(base, "linked-stage");
      expect(spawnSync("python3", ["-B", "-c", stagePython, validator, linked.source, linkedStage, linked.home], { encoding: "utf8" }).status).not.toBe(0);
      await expect(stat(linkedStage)).rejects.toThrow();

      await mkdir(join(base, "hostile"));
      const hostile = await makeFixture(join(base, "hostile"), "fixture");
      await mkdir(join(hostile.home, ".ais-live-model-cache"), { mode: 0o777 });
      expect(validate(hostile.source, hostile.home).status).not.toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
