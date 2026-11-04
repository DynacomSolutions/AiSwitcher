import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { parseArgs } from "../../src/cli/args.ts";
import { runBrowserCommand } from "../../src/cli/browser/dispatch.ts";

const SCRATCH = process.env.AIS_TEST_SCRATCH_DIR ? join(process.env.AIS_TEST_SCRATCH_DIR, "browser-cli") : join(import.meta.dir, "..", "gateway", ".tmp", "browser-cli");
const TOKEN = "aisbr_SECRETTOKEN0123456789";
let dir: string;
let secrets: string;
let out: string[];
let seen: { method: string; path: string; body: unknown }[];
let app: Hono;
let dirs: string[];

const run = (line: string, identityDirs?: (id: string) => Promise<{ name: string; dirs: string[] }>) => {
  const { positionals, flags } = parseArgs(line.split(" ").filter(Boolean));
  return runBrowserCommand(positionals.slice(1), flags, {
    secretsPath: secrets,
    fetch: ((url: string, init: RequestInit) => app.request(url, init)) as unknown as typeof fetch,
    out: (s) => out.push(s),
    identityDirs: identityDirs ?? (async () => ({ name: "work", dirs })),
  });
};

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, "case-"));
  secrets = join(dir, "secrets");
  writeFileSync(secrets, "AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN=adm-1\nOTHER=keep\n", { mode: 0o600 });
  dirs = [join(dir, "claude-work"), join(dir, "codex-work")];
  out = [];
  seen = [];
  app = new Hono();
  app.all("*", async (c) => {
    const body = c.req.method === "POST" || c.req.method === "PUT" ? await c.req.json().catch(() => undefined) : undefined;
    seen.push({ method: c.req.method, path: new URL(c.req.url).pathname, body });
    const p = new URL(c.req.url).pathname;
    if (p.endsWith("/approve")) return c.json({ binding: { name: "my-chrome", target: (body as { target: unknown }).target, profileLabel: "P", state: "active" } });
    if (p === "/browser/bindings") return c.json({ bindings: [{ name: "my-chrome", target: { kind: "pool", pool: "p1" }, profileLabel: "P", state: "active" }] });
    if (p.endsWith("/tokens") && c.req.method === "POST") return c.json({ token: TOKEN });
    return c.json({ ok: true });
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("approve", () => {
  test("identity target body", async () => {
    await run("browser approve ABCD2345 --identity=work --name=my-chrome");
    expect(seen[0]).toEqual({ method: "POST", path: "/browser/pairings/ABCD2345/approve", body: { target: { kind: "identity", identity: "work" }, name: "my-chrome" } });
    expect(seen[0]!.body).not.toHaveProperty("pool");
  });
  test("pool target body, no name", async () => {
    await run("browser approve ABCD2345 --pool=p1");
    expect(seen[0]!.body).toEqual({ target: { kind: "pool", pool: "p1" } });
  });
  test("mutually exclusive and one required", async () => {
    await expect(run("browser approve ABCD2345 --identity=a --pool=b")).rejects.toThrow(/not both/);
    await expect(run("browser approve ABCD2345")).rejects.toThrow(/Choose a target/);
    await expect(run("browser approve --identity=a")).rejects.toThrow(/Usage/);
    expect(seen).toEqual([]);
  });
});

test("list and revoke", async () => {
  await run("browser list");
  expect(out.join("\n")).toContain("pool:p1");
  await run("browser revoke my-chrome");
  expect(seen[1]).toMatchObject({ method: "DELETE", path: "/browser/bindings/my-chrome" });
});

describe("agent-token", () => {
  test("writes 0600 files and secrets key, never prints token", async () => {
    await run("browser agent-token work");
    for (const d of dirs) {
      const f = join(d, "ais-browser-token");
      expect(readFileSync(f, "utf8").trim()).toBe(TOKEN);
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(secrets, "utf8")).toContain(`AIS_BROWSER_AGENT_WORK_TOKEN=${TOKEN}`);
    expect(readFileSync(secrets, "utf8")).toContain("OTHER=keep");
    expect(out.join("\n")).not.toContain(TOKEN);
  });
  test("errors when no tool has the identity, without minting", async () => {
    await expect(run("browser agent-token ghost", async () => ({ name: "ghost", dirs: [] }))).rejects.toThrow(/not found/);
    expect(seen).toEqual([]);
  });
  test("--revoke deletes files and key", async () => {
    await run("browser agent-token work");
    await run("browser agent-token work --revoke");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/browser/agents/work/tokens" });
    for (const d of dirs) expect(existsSync(join(d, "ais-browser-token"))).toBe(false);
    const text = readFileSync(secrets, "utf8");
    expect(text).not.toContain("AIS_BROWSER_AGENT_WORK_TOKEN");
    expect(text).toContain("OTHER=keep");
  });
});
