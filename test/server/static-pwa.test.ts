import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const dist = mkdtempSync(join(tmpdir(), "ais-static-pwa-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>AIS Console</title>");
writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
writeFileSync(join(dist, "manifest.webmanifest"), "{}");
writeFileSync(join(dist, "sw.js"), "// sw");
writeFileSync(join(dist, "icon-192.png"), "png");
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const app = createApp({ token: "t", port: 47129, startedAt: Date.now(), distDir: dist });

describe("static WebUI for the PWA", () => {
  test("hashed bundle under /assets/ stays immutable", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("manifest has its MIME type and revalidates", async () => {
    const res = await app.request("/manifest.webmanifest");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("service worker and icons revalidate so new releases reach installs", async () => {
    for (const path of ["/sw.js", "/icon-192.png", "/"]) {
      expect((await app.request(path)).headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("PWA files are served without the API token", async () => {
    expect((await app.request("/manifest.webmanifest")).status).toBe(200);
    expect((await app.request("/sw.js")).status).toBe(200);
  });
});

describe("apps/web PWA files", () => {
  const web = join(import.meta.dir, "..", "..", "apps", "web");
  const manifest = JSON.parse(readFileSync(join(web, "public", "manifest.webmanifest"), "utf8")) as {
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  test("manifest meets browser install criteria", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.filter((icon) => icon.purpose === "any").map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  test("every manifest icon exists", () => {
    for (const icon of manifest.icons) expect(existsSync(join(web, "public", icon.src))).toBe(true);
  });

  test("index.html links the manifest", () => {
    expect(readFileSync(join(web, "index.html"), "utf8")).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  test("service worker never caches or touches API requests", () => {
    const sw = readFileSync(join(web, "public", "sw.js"), "utf8");
    expect(sw).not.toMatch(/caches\.|cache\.put/);
    expect(sw).toContain('event.request.mode !== "navigate"');
  });
});
