import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureUsageProxy, folderUsageProxyProblem, usageProxyProblem, withLoopbackNoProxy, withUsageProxy } from "../../src/identities/claude-usage-proxy.ts";

const PROXY = "http://proxy.example.test:47132";
const LOCAL = "http://127.0.0.1:47140/claude";
const root = await mkdtemp(join(tmpdir(), "ais-usage-proxy-"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("usageProxyProblem", () => {
  test("HTTPS_PROXY with a loopback ANTHROPIC_BASE_URL and no NO_PROXY is the 405 incident", () => {
    expect(usageProxyProblem({ ANTHROPIC_BASE_URL: LOCAL, HTTPS_PROXY: PROXY })).toContain("NO_PROXY");
  });
  for (const key of ["https_proxy", "HTTP_PROXY", "ALL_PROXY"]) {
    test(`${key} counts as a proxy too`, () => {
      expect(usageProxyProblem({ ANTHROPIC_BASE_URL: LOCAL, [key]: PROXY })).toBeDefined();
    });
  }
  for (const base of ["http://localhost:47140/claude", "http://[::1]:47140/claude", "http://127.0.0.2:1/x"]) {
    test(`loopback base ${base} needs NO_PROXY`, () => {
      expect(usageProxyProblem({ ANTHROPIC_BASE_URL: base, HTTPS_PROXY: PROXY })).toBeDefined();
    });
  }
  test("a NO_PROXY that does not name the base host is still a problem", () => {
    expect(usageProxyProblem({ ANTHROPIC_BASE_URL: LOCAL, HTTPS_PROXY: PROXY, NO_PROXY: "localhost,::1" })).toBeDefined();
  });
  for (const noProxy of ["127.0.0.1,localhost,::1", "localhost, 127.0.0.1", "127.0.0.1:47140", "*"]) {
    test(`NO_PROXY "${noProxy}" exempts the loopback base`, () => {
      expect(usageProxyProblem({ ANTHROPIC_BASE_URL: LOCAL, HTTPS_PROXY: PROXY, NO_PROXY: noProxy })).toBeUndefined();
    });
  }
  test("lower-case no_proxy counts", () => {
    expect(usageProxyProblem({ ANTHROPIC_BASE_URL: LOCAL, HTTPS_PROXY: PROXY, no_proxy: "127.0.0.1" })).toBeUndefined();
  });
  test("a remote https base, no proxy, or no base is fine", () => {
    expect(usageProxyProblem({ ANTHROPIC_BASE_URL: "https://gateway.example.test/gw/app", HTTPS_PROXY: PROXY })).toBeUndefined();
    expect(usageProxyProblem({ ANTHROPIC_BASE_URL: LOCAL })).toBeUndefined();
    expect(usageProxyProblem({ HTTPS_PROXY: PROXY })).toBeUndefined();
    expect(usageProxyProblem(undefined)).toBeUndefined();
  });
});

describe("withUsageProxy", () => {
  test("never sets HTTPS_PROXY without a loopback NO_PROXY, and keeps other keys", () => {
    const out = withUsageProxy({ model: "x", env: { ANTHROPIC_BASE_URL: LOCAL, KEEP: "1" } }, { proxyUrl: PROXY, caPath: "/ca.pem" });
    expect(out.model).toBe("x");
    expect(out.env).toEqual({ ANTHROPIC_BASE_URL: LOCAL, KEEP: "1", HTTPS_PROXY: PROXY, NODE_EXTRA_CA_CERTS: "/ca.pem", NO_PROXY: "127.0.0.1,localhost,::1" });
    expect(usageProxyProblem(out.env as Record<string, unknown>)).toBeUndefined();
  });
  test("an existing NO_PROXY keeps its entries and gains the loopback ones once", () => {
    expect(withLoopbackNoProxy("internal.example.test,LOCALHOST")).toBe("internal.example.test,LOCALHOST,127.0.0.1,::1");
    const out = withUsageProxy({ env: { no_proxy: "internal.example.test" } }, { proxyUrl: PROXY, caPath: "/ca.pem" });
    expect((out.env as Record<string, unknown>).NO_PROXY).toBe("internal.example.test,127.0.0.1,localhost,::1");
    expect((out.env as Record<string, unknown>).no_proxy).toBeUndefined();
  });
  test("refuses a bad proxy URL or a missing CA", () => {
    expect(() => withUsageProxy({}, { proxyUrl: "proxy:1", caPath: "/ca.pem" })).toThrow();
    expect(() => withUsageProxy({}, { proxyUrl: PROXY, caPath: " " })).toThrow();
  });
});

describe("folders", () => {
  test("configureUsageProxy writes settings.json 0600 and the folder then passes the check", async () => {
    const dir = await mkdtemp(join(root, "swap-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: LOCAL, HTTPS_PROXY: PROXY } }));
    expect(await folderUsageProxyProblem(dir)).toBeDefined();
    await configureUsageProxy(dir, { proxyUrl: PROXY, caPath: "/ca.pem" });
    expect(await folderUsageProxyProblem(dir)).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect((await stat(join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
  });
  test("turning the proxy on adds user:profile to a gateway entry, and never touches a real login", async () => {
    const gw = await mkdtemp(join(root, "gw-"));
    await writeFile(join(gw, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_t", refreshToken: null, scopes: ["user:inference"] } }));
    await configureUsageProxy(gw, { proxyUrl: PROXY, caPath: "/ca.pem" });
    expect(JSON.parse(await readFile(join(gw, ".credentials.json"), "utf8")).claudeAiOauth.scopes).toEqual(["user:inference", "user:profile"]);
    const real = await mkdtemp(join(root, "real-"));
    const login = JSON.stringify({ claudeAiOauth: { accessToken: "at-SYNTHETIC_FIXTURE", refreshToken: "rt-SYNTHETIC_FIXTURE", scopes: ["user:inference"] } });
    await writeFile(join(real, ".credentials.json"), login);
    await configureUsageProxy(real, { proxyUrl: PROXY, caPath: "/ca.pem" });
    expect(await readFile(join(real, ".credentials.json"), "utf8")).toBe(login);
  });

  test("a folder with no settings gets one; an unreadable one is not reported", async () => {
    const dir = await mkdtemp(join(root, "t3-"));
    expect(await folderUsageProxyProblem(dir)).toBeUndefined();
    await configureUsageProxy(dir, { proxyUrl: PROXY, caPath: "/ca.pem" });
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).env.HTTPS_PROXY).toBe(PROXY);
    await writeFile(join(dir, "settings.json"), "{not json");
    expect(await folderUsageProxyProblem(dir)).toBeUndefined();
  });
});
