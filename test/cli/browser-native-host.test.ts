import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { aisCommand, encodeFrame, handleHostRequest, HOST_NAME, installNativeHost, isNewer, latestVersion, nativeHostDirs, readFrame, runNativeHost, unpackedExtensionId } from "../../src/cli/browser/native-host.ts";

const redirectTo = (tag: string): typeof fetch => (async (url: string | URL | Request) => {
  if (String(url).endsWith("/releases/latest")) return new Response(null, { status: 302, headers: { location: `https://github.com/DynacomSolutions/AiSwitcher/releases/tag/${tag}` } });
  return new Response("nope", { status: 500 });
}) as typeof fetch;

describe("AIS Browser native helper", () => {
  test("extension id matches Chrome's unpacked id (same derivation the e2e uses)", () => {
    const p = "/srv/example/.ais/browser-extension";
    const expected = [...createHash("sha256").update(p).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
    expect(unpackedExtensionId(p)).toBe(expected);
    expect(unpackedExtensionId(p)).toMatch(/^[a-p]{32}$/);
  });

  test("install writes a launcher and a host manifest for each Chrome present", async () => {
    const home = mkdtempSync(join(tmpdir(), "ais-host-"));
    try {
      mkdirSync(join(home, "Library/Application Support/Google/Chrome"), { recursive: true });
      const ext = join(home, ".ais/browser-extension");
      mkdirSync(ext, { recursive: true });
      const written = await installNativeHost({ extensionDir: ext, home, platform: "darwin", command: ["/opt/example/bin/ais"], out: () => {} });
      expect(written).toEqual([join(home, `Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`)]);
      const m = JSON.parse(readFileSync(written[0]!, "utf8"));
      expect(m).toMatchObject({ name: HOST_NAME, type: "stdio", path: join(home, ".ais/browser-host/ais-browser-host"), allowed_origins: [`chrome-extension://${unpackedExtensionId(ext)}/`] });
      const launcher = readFileSync(m.path, "utf8");
      expect(launcher).toBe(`#!/bin/sh\nexec '/opt/example/bin/ais' browser extension host "$@"\n`);
      expect(statSync(m.path).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("only browsers that exist get a manifest; Windows is skipped", () => {
    const has = new Set(["/h/.config/chromium"]);
    expect(nativeHostDirs("linux", "/h", p => has.has(p))).toEqual(["/h/.config/chromium/NativeMessagingHosts"]);
    expect(nativeHostDirs("win32", "/h", () => true)).toEqual([]);
  });

  test("launcher runs bun with the entry script when ais runs from source", () => {
    expect(aisCommand("/usr/bin/bun", "src/ais.ts")[0]).toBe("/usr/bin/bun");
    expect(aisCommand("/usr/bin/bun", "src/ais.ts")).toHaveLength(2);
    expect(aisCommand("/opt/example/bin/ais", "/whatever")).toEqual(["/opt/example/bin/ais"]);
  });

  test("framing round trip, split across chunks", async () => {
    const frame = encodeFrame({ type: "check" });
    async function* chunks() { yield frame.subarray(0, 2); yield frame.subarray(2, 7); yield frame.subarray(7); }
    expect(await readFrame(chunks())).toEqual({ type: "check" });
  });

  test("check reports latest from the release redirect and the installed version", async () => {
    const ext = mkdtempSync(join(tmpdir(), "ais-ext-"));
    try {
      writeFileSync(join(ext, "manifest.json"), JSON.stringify({ version: "0.5.45" }));
      expect(await handleHostRequest({ type: "check" }, { extensionDir: ext, fetch: redirectTo("v0.5.46"), update: async () => {} })).toEqual({ ok: true, latest: "0.5.46", installed: "0.5.45" });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  test("update replaces only for a newer release, never downgrades", async () => {
    const ext = mkdtempSync(join(tmpdir(), "ais-ext-"));
    try {
      writeFileSync(join(ext, "manifest.json"), JSON.stringify({ version: "0.5.45" }));
      let updates = 0;
      const update = async () => { updates++; writeFileSync(join(ext, "manifest.json"), JSON.stringify({ version: "0.5.46" })); };
      expect(await handleHostRequest({ type: "update" }, { extensionDir: ext, fetch: redirectTo("v0.5.44"), update })).toMatchObject({ ok: true, updated: false, installed: "0.5.45" });
      expect(await handleHostRequest({ type: "update" }, { extensionDir: ext, fetch: redirectTo("v0.5.46"), update })).toEqual({ ok: true, latest: "0.5.46", installed: "0.5.46", updated: true });
      expect(updates).toBe(1);
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  test("errors come back as a reply, and the host writes exactly one frame", async () => {
    const outs: Uint8Array[] = [];
    async function* input() { yield encodeFrame({ type: "check" }); }
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await runNativeHost({ extensionDir: "/nonexistent", fetch: failing, update: async () => {} }, input(), b => outs.push(b));
    expect(outs).toHaveLength(1);
    expect(await readFrame((async function* () { yield outs[0]!; })())).toEqual({ ok: false, error: "offline" });
    expect(await handleHostRequest({ type: "rm -rf" }, { extensionDir: "/x", fetch: failing, update: async () => {} })).toEqual({ ok: false, error: "unknown request" });
  });

  test("latest falls back to the API when there is no redirect", async () => {
    const f = (async (url: string | URL | Request) => String(url).includes("api.github.com") ? Response.json({ tag_name: "v1.2.3" }) : new Response("", { status: 200 })) as typeof fetch;
    expect(await latestVersion(f)).toBe("1.2.3");
    expect(isNewer("1.2.3", "1.2.2")).toBe(true);
  });
});
