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
  test("builds on anything but an explicit false and never schedules", () => {
    expect(text).toContain("needs.changes.outputs.affected != 'false'");
    expect(text).not.toMatch(/^\s*schedule:/m);
    expect(text).not.toMatch(/runs-on: (?!ubuntu-latest)/);
  });
});
