import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// One app mark everywhere. icon.svg is the source for favicon.png and the
// Tauri icons (scripts/render-icons.sh); the WebUI inlines the same SVG.
const root = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(root, p));

describe("app icon", () => {
  test("WebUI favicon is the same SVG as the host icon source", () => {
    const html = read("apps/web/index.html").toString();
    const href = html.match(/rel="icon"\s+href="data:image\/svg\+xml,([^"]+)"/)?.[1];
    expect(href).toBeDefined();
    const inline = decodeURIComponent(href!).replace(/'/g, '"');
    expect(inline).toBe(read("apps/host/src-tauri/icons/icon.svg").toString().trim());
  });

});
