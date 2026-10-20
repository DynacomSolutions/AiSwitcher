import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const text = readFileSync(".github/workflows/live-image.yml", "utf8");
const lines = text.split("\n");

describe("live-image workflow", () => {
  test("every run step is strict bash", () => {
    expect(text).toMatch(/defaults:\n {2}run:\n {4}shell: bash/);
    const runs = lines.flatMap((l, i) => (/^\s*run: /.test(l) ? [i] : []));
    expect(runs.length).toBeGreaterThan(0);
    for (const i of runs) {
      expect(lines[i].trim()).toBe("run: |");
      expect(lines[i + 1].trim()).toBe("set -euo pipefail");
    }
    expect(text).not.toMatch(/build\.sh[^\n]*\|\s*tee/);
  });
  test("every action is pinned to a full commit SHA with a version comment", () => {
    const uses = lines.filter((l) => /^\s*(- )?uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
  test("builds after selector failure or timeout, skips only affected=false, and never schedules", () => {
    const condition = lines.find((line) => /^    if:.*needs\.changes\.outputs\.affected/.test(line));
    expect(condition).toBe("    if: ${{ !cancelled() && needs.changes.outputs.affected != 'false' }}");
    const expression = condition?.match(/\$\{\{\s*(.*?)\s*\}\}/)?.[1];
    expect(expression).toBeDefined();
    const evaluate = (cancelled: boolean, selectorResult: "success" | "failure" | "timed_out", affected: string) => {
      const value = expression
        ?.replace(/!cancelled\(\)/g, String(!cancelled))
        .replace(/needs\.changes\.outputs\.affected/g, JSON.stringify(affected))
        .replace(/!=/g, "!==");
      const implicitSuccess = expression?.includes("!cancelled()")
        ? true
        : selectorResult === "success";
      return implicitSuccess && Boolean(value && Function(`return (${value})`)());
    };
    expect(evaluate(false, "failure", "")).toBe(true);
    expect(evaluate(false, "timed_out", "")).toBe(true);
    expect(evaluate(false, "success", "true")).toBe(true);
    expect(evaluate(false, "success", "false")).toBe(false);
    expect(evaluate(true, "success", "true")).toBe(false);
    expect(text).not.toMatch(/^\s*schedule:/m);
    expect(text).not.toMatch(/runs-on: (?!ubuntu-latest)/);
  });
});

test("the EFI loader is built from the image's own Arch GRUB modules", () => {
  // Ubuntu's standalone GRUB leaves $cmdpath empty and the boot-partition check halts.
  expect(text).toContain("AIS_GRUB_MODULE_DIR=out/grub-x86_64-efi image/build/assemble.sh");
  expect(readFileSync("image/build/build.sh", "utf8")).toContain('cp -a "$root/usr/lib/grub/x86_64-efi" "$out/grub-x86_64-efi"');
});
