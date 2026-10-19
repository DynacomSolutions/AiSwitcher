import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageAffected } from "../../image/build/affected.ts";

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
      Bun.spawnSync(["bun", "image/build/affected.ts", meta], { stdin: new TextEncoder().encode(stdin) }).stdout.toString().trim();
    expect(run("docs/x.md\n")).toBe("false");
    expect(run("src/ais.ts\n")).toBe("true");
    rmSync(dir, { recursive: true, force: true });
  });
});
