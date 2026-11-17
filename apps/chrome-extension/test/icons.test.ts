import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
  icons: Record<string, string>;
  action: { default_icon: Record<string, string> };
};

describe("extension icons", () => {
  test("the manifest names the AIS icon at every size Chrome uses, and each file exists", () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "32", "48"]);
    for (const p of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) expect(existsSync(join(root, p))).toBe(true);
  });
  test("each PNG has the size its key names", () => {
    for (const [size, p] of Object.entries(manifest.icons)) {
      const png = readFileSync(join(root, p));
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
  });
  test("the side panel shows the same icon", () => {
    expect(readFileSync(join(root, "src/sidepanel/sidepanel.html"), "utf8")).toContain('src="icons/icon-48.png"');
  });
});
