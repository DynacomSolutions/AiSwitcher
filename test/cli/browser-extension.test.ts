import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runBrowserCommand } from "../../src/cli/browser/dispatch.ts";
import { swapIn, unsafeEntry, type CommandResult } from "../../src/cli/browser/extension.ts";

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

const real = async (cmd: string[]): Promise<CommandResult> => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stderr, stdout };
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

  test("update downloads the public asset without credentials and installs", async () => {
    const zip = await makeZip("pub", { "manifest.json": '{"version":"3"}' });
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(Bun.file(zip));
    }) as unknown as typeof fetch;
    await run("browser extension update", { fetch: fakeFetch, platform: "linux" });
    expect(seen).toEqual([{ url: "https://github.com/DynacomSolutions/AiSwitcher/releases/latest/download/ais-browser-extension.zip", auth: null }]);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"3"');
  });

  test("a bad GITHUB_TOKEN and a gh that exits 401 do not block the public download", async () => {
    const zip = await makeZip("bad-tok", { "manifest.json": '{"version":"4"}' });
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      return url.startsWith("https://api.github.com") ? new Response("Bad credentials", { status: 401 }) : new Response(Bun.file(zip));
    }) as unknown as typeof fetch;
    const calls: string[][] = [];
    const runCmd = async (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      return cmd[0] === "gh" ? { code: 1, stderr: "HTTP 401: Bad credentials" } : real(cmd);
    };
    const saved = { g: process.env.GITHUB_TOKEN, h: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = "bad";
    process.env.GH_TOKEN = "bad";
    try {
      await run("browser extension update", { run: runCmd, fetch: fakeFetch, platform: "linux" });
    } finally {
      if (saved.g === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.g;
      if (saved.h === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.h;
    }
    expect(seen.every((u) => u.startsWith("https://github.com/"))).toBe(true);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"4"');
  });

  test("a failed download reports the HTTP status and keeps the old folder", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.json"), '{"version":"0"}');
    const fakeFetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(run("browser extension update", { fetch: fakeFetch, platform: "linux" })).rejects.toThrow(/HTTP 500/);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"0"');
    expect(readdirSync(join(dir, "home"))).toEqual(["browser-extension"]);
  });

  test("unknown subcommand is a usage error", async () => {
    await expect(run("browser extension nope")).rejects.toThrow(/Usage/);
  });

  test("a zip with a traversal entry is rejected before extraction", async () => {
    const src = join(dir, "trav");
    mkdirSync(join(src, "inner"), { recursive: true });
    writeFileSync(join(src, "manifest.json"), "{}");
    writeFileSync(join(src, "evil.txt"), "x");
    const zip = join(dir, "trav.zip");
    await Bun.spawn(["zip", "-q", zip, "../evil.txt"], { cwd: join(src, "inner") }).exited;
    await Bun.spawn(["zip", "-q", zip, "manifest.json"], { cwd: src }).exited;
    expect((await real(["unzip", "-Z1", zip])).stdout).toContain("../evil.txt");
    await expect(run(`browser extension update --from=${zip}`)).rejects.toThrow(/escapes/);
    expect(existsSync(target)).toBe(false);
  });

  test("a zip containing a symlink is rejected", async () => {
    const src = join(dir, "sym");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "manifest.json"), "{}");
    symlinkSync("/etc", join(src, "link"));
    const zip = join(dir, "sym.zip");
    await Bun.spawn(["zip", "-q", "-y", "-r", zip, "."], { cwd: src }).exited;
    await expect(run(`browser extension update --from=${zip}`)).rejects.toThrow(/symlink/);
    expect(existsSync(target)).toBe(false);
  });

  test("unsafeEntry", () => {
    expect(["/abs", "a/../b", "..", "C:x", "\\srv"].every(unsafeEntry)).toBe(true);
    expect(["manifest.json", "icons/a..b.png"].some(unsafeEntry)).toBe(false);
  });

  test("darwin uses zipinfo and ditto", async () => {
    const zip = await makeZip("dar", { "manifest.json": "{}" });
    const calls: string[][] = [];
    const runCmd = async (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      if (cmd[0] === "zipinfo") return { code: 0, stderr: "", stdout: "manifest.json\n" };
      if (cmd[0] === "ditto") return real(["unzip", "-q", "-o", cmd[3]!, "-d", cmd[4]!]);
      return real(cmd);
    };
    await run(`browser extension update --from=${zip}`, { run: runCmd, platform: "darwin" });
    expect(calls.map((c) => c[0])).toEqual(["zipinfo", "ditto"]);
    expect(calls[0]).toEqual(["zipinfo", "-1", zip]);
    expect(calls[1]!.slice(0, 3)).toEqual(["ditto", "-x", "-k"]);
  });

  test("swap rollback: failed rename-in restores the old folder", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.json"), '{"version":"0"}');
    await expect(swapIn(target, join(dir, "does-not-exist"), () => {})).rejects.toThrow();
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"0"');
    expect(existsSync(`${target}.old`)).toBe(false);
  });

  test("a leftover .old with no target is restored on start", async () => {
    mkdirSync(`${target}.old`, { recursive: true });
    writeFileSync(join(`${target}.old`, "manifest.json"), '{"version":"0"}');
    const zip = join(dir, "corrupt2.zip");
    writeFileSync(zip, "nope");
    await expect(run(`browser extension update --from=${zip}`)).rejects.toThrow();
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"0"');
  });

  test("failure to remove the old copy after a good swap only warns", async () => {
    mkdirSync(join(target, "sub"), { recursive: true });
    writeFileSync(join(target, "manifest.json"), "{}");
    writeFileSync(join(target, "sub", "f"), "x");
    chmodSync(join(target, "sub"), 0o500);
    const fresh = join(dir, "fresh");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "manifest.json"), '{"v":2}');
    const warnings: string[] = [];
    try {
      await swapIn(target, fresh, (l) => warnings.push(l));
    } finally {
      chmodSync(join(`${target}.old`, "sub"), 0o700);
    }
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toContain('"v":2');
    if (process.getuid?.() !== 0) expect(warnings.join()).toContain("could not remove");
  });
});
