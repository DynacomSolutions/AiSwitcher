import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageAffected } from "../../image/build/affected.ts";

const script = join(import.meta.dir, "../../image/build/affected.ts");

const inputs = ["src/ais.ts", "src/shared/exec.ts"];

describe("imageAffected", () => {
  test("image files are affected", () => {
    expect(imageAffected(["image/lib/x"], inputs)).toBe(true);
  });
  test("unrelated docs are not", () => {
    expect(imageAffected(["docs/foo.md"], inputs)).toBe(false);
  });
  test("a metafile input is affected", () => {
    expect(imageAffected(["src/shared/exec.ts"], inputs)).toBe(true);
  });
  test("shared inputs run everything", () => {
    for (const f of ["bun.lock", "package.json", "tsconfig.json", ".github/workflows/live-image.yml", "image/pins.env"]) {
      expect(imageAffected([f], inputs)).toBe(true);
    }
  });
  test("the tui is affected", () => {
    expect(imageAffected(["apps/tui/src/main.rs"], inputs)).toBe(true);
  });
  test("apps/web is affected only when listed in the metafile", () => {
    expect(imageAffected(["apps/web/src/app.tsx"], inputs)).toBe(false);
    expect(imageAffected(["apps/web/src/app.tsx"], [...inputs, "apps/web/src/app.tsx"])).toBe(true);
  });
  test("the CLI fails open without a metafile", () => {
    const run = Bun.spawnSync(["bun", "image/build/affected.ts", "/nonexistent.json"], { stdin: new TextEncoder().encode("docs/x.md\n") });
    expect(run.stdout.toString().trim()).toBe("true");
  });
  test("the CLI reads stdin and a metafile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "affected-"));
    const meta = join(dir, "m.json");
    await Bun.write(meta, JSON.stringify({ inputs: { "src/ais.ts": {} } }));
    const run = (stdin: string) =>
      Bun.spawnSync(["bun", script, meta], { stdin: new TextEncoder().encode(stdin) }).stdout.toString().trim();
    expect(run("docs/x.md\n")).toBe("false");
    expect(run("src/ais.ts\n")).toBe("true");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("version-only package.json bumps", () => {
  test("the CLI skips a version-only bump but keeps real package.json changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "affected-version-"));
    try {
      const git = (args: string[]) => {
        const run = Bun.spawnSync(["git", ...args], { cwd: dir });
        if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
        return run.stdout.toString().trim();
      };
      git(["init", "-q"]);
      git(["config", "user.email", "ci@example.invalid"]);
      git(["config", "user.name", "CI test"]);
      const meta = join(dir, "m.json");
      writeFileSync(meta, JSON.stringify({ inputs: { "package.json": {}, "src/ais.ts": {} } }));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.5.75" }));
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.5.76" }));
      git(["add", "."]);
      git(["commit", "-qm", "bump"]);
      const bump = git(["rev-parse", "HEAD"]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.5.76", dependencies: { hono: "^4.13.6" } }));
      git(["add", "."]);
      git(["commit", "-qm", "dependency"]);
      const dependency = git(["rev-parse", "HEAD"]);
      const run = (stdin: string, head: string, withBase = true) =>
        Bun.spawnSync(["bun", script, meta], {
          cwd: dir,
          stdin: new TextEncoder().encode(stdin),
          env: { ...process.env, ...(withBase ? { BASE_SHA: base } : {}), HEAD_SHA: head },
        }).stdout.toString().trim();
      expect(run("package.json\n", bump)).toBe("false");
      expect(run("package.json\nsrc/ais.ts\n", bump)).toBe("true");
      expect(run("package.json\n", dependency)).toBe("true");
      // Without a readable base the bump cannot be verified: fail open.
      expect(run("package.json\n", bump, false)).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
