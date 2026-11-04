import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runBrowserCommand } from "../../src/cli/browser/dispatch.ts";
import type { CommandResult } from "../../src/cli/browser/extension.ts";

const SCRATCH = process.env.AIS_TEST_SCRATCH_DIR ? join(process.env.AIS_TEST_SCRATCH_DIR, "browser-ext") : join(import.meta.dir, "..", "gateway", ".tmp", "browser-ext");
let dir: string;
let target: string;
let out: string[];

const makeZip = async (name: string, files: Record<string, string>): Promise<string> => {
  const src = join(dir, `src-${name}`);
  mkdirSync(src, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body);
  const zip = join(dir, `${name}.zip`);
  const p = Bun.spawn(["zip", "-q", "-r", zip, "."], { cwd: src });
  await p.exited;
  return zip;
};

const run = (line: string, extra: Record<string, unknown> = {}) => {
  const { positionals, flags } = parseArgs(line.split(" ").filter(Boolean));
  return runBrowserCommand(positionals.slice(1), flags, { extensionDir: target, out: (s: string) => out.push(s), ...extra });
};

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, "case-"));
  target = join(dir, "home", "browser-extension");
  out = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("ais browser extension", () => {
  test("path prints the target", async () => {
    await run("browser extension path");
    expect(out).toEqual([target]);
  });

  test("update --from unpacks into a fresh target and prints the reload instruction", async () => {
    const zip = await makeZip("v1", { "manifest.json": '{"version":"1"}', "bg.js": "x" });
    await run(`browser extension update --from=${zip}`);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"1"');
    expect(out.join("\n")).toContain("Reload the extension in each Chrome profile");
    expect(readdirSync(join(dir, "home"))).toEqual(["browser-extension"]);
  });

  test("update replaces an existing install and leaves no .old or temp dirs", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.json"), '{"version":"0"}');
    writeFileSync(join(target, "stale.js"), "stale");
    const zip = await makeZip("v2", { "manifest.json": '{"version":"2"}' });
    await run(`browser extension update --from=${zip}`);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"2"');
    expect(existsSync(join(target, "stale.js"))).toBe(false);
    expect(readdirSync(join(dir, "home"))).toEqual(["browser-extension"]);
  });

  test("a zip without manifest.json keeps the old folder", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.json"), '{"version":"0"}');
    const zip = await makeZip("bad", { "other.txt": "x" });
    await expect(run(`browser extension update --from=${zip}`)).rejects.toThrow(/manifest\.json/);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"0"');
    expect(readdirSync(join(dir, "home"))).toEqual(["browser-extension"]);
  });

  test("a corrupt zip keeps the old folder", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.json"), '{"version":"0"}');
    const zip = join(dir, "corrupt.zip");
    writeFileSync(zip, "not a zip");
    await expect(run(`browser extension update --from=${zip}`)).rejects.toThrow();
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"0"');
  });

  test("update downloads with gh and installs", async () => {
    const zip = await makeZip("gh", { "manifest.json": '{"version":"3"}' });
    const calls: string[][] = [];
    const runCmd = async (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      if (cmd[0] === "gh") {
        await Bun.write(join(cmd[cmd.indexOf("--dir") + 1]!, "ais-browser-extension.zip"), Bun.file(zip));
        return { code: 0, stderr: "" };
      }
      const p = Bun.spawn(cmd, { stderr: "pipe" });
      return { code: await p.exited, stderr: "" };
    };
    await run("browser extension update", { run: runCmd, platform: "linux" });
    expect(calls[0]!.slice(0, 6)).toEqual(["gh", "release", "download", "--repo", "DynacomSolutions/AiSwitcher", "--pattern"]);
    expect(calls[0]![6]).toBe("ais-browser-extension.zip");
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"3"');
  });

  test("without gh falls back to the REST API with the token", async () => {
    const zip = await makeZip("api", { "manifest.json": '{"version":"4"}' });
    const seen: { url: string; accept: string | null; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, accept: h.get("accept"), auth: h.get("authorization") });
      if (url.endsWith("/releases/latest")) return Response.json({ assets: [{ name: "other.zip", url: "https://x/other" }, { name: "ais-browser-extension.zip", url: "https://api.test/asset/1" }] });
      return new Response(Bun.file(zip));
    }) as unknown as typeof fetch;
    const runCmd = async (cmd: string[]): Promise<CommandResult> => {
      if (cmd[0] === "gh") return { code: 127, stderr: "not found" };
      const p = Bun.spawn(cmd, { stderr: "pipe" });
      return { code: await p.exited, stderr: "" };
    };
    await run("browser extension update", { run: runCmd, fetch: fakeFetch, env: { GH_TOKEN: "tok" }, platform: "linux" });
    expect(seen[1]).toEqual({ url: "https://api.test/asset/1", accept: "application/octet-stream", auth: "Bearer tok" });
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"4"');
  });

  test("without gh or a token fails and keeps the old folder", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.json"), '{"version":"0"}');
    const runCmd = async (): Promise<CommandResult> => ({ code: 127, stderr: "" });
    await expect(run("browser extension update", { run: runCmd, env: {} })).rejects.toThrow(/GITHUB_TOKEN/);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"0"');
    expect(readdirSync(join(dir, "home"))).toEqual(["browser-extension"]);
  });

  test("unknown subcommand is a usage error", async () => {
    await expect(run("browser extension nope")).rejects.toThrow(/Usage/);
  });
});
