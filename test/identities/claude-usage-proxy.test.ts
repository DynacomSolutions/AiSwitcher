import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDirectGateway, directGatewayProblem, folderUsageProxyProblem, withDirectGateway } from "../../src/identities/claude-usage-proxy.ts";

const GATEWAY = "https://gateway.example.test/gateway/agents-claude";
const LOCAL = "http://127.0.0.1:47140/claude";
const root = await mkdtemp(join(tmpdir(), "ais-usage-proxy-"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("directGatewayProblem", () => {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    test(`${key} is rejected`, () => {
      expect(directGatewayProblem({ ANTHROPIC_BASE_URL: GATEWAY, [key]: "https://proxy.example.test" })).toContain(key);
    });
  }
  test("does not reject unrelated settings or an absent environment", () => {
    expect(directGatewayProblem({ KEEP: "1" })).toBeUndefined();
    expect(directGatewayProblem(undefined)).toBeUndefined();
  });
});

describe("withDirectGateway", () => {
  test("sets the direct base, removes generic proxy settings and keeps unrelated keys", () => {
    const out = withDirectGateway({ model: "x", env: {
      ANTHROPIC_BASE_URL: LOCAL,
      KEEP: "1",
      HTTPS_PROXY: "https://proxy.example.test",
      http_proxy: "http://proxy.example.test",
      ALL_PROXY: "http://proxy.example.test",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
    } }, GATEWAY);
    expect(out.model).toBe("x");
    expect(out.env).toEqual({ ANTHROPIC_BASE_URL: GATEWAY, KEEP: "1", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/ca.pem" });
  });
  test("accepts loopback HTTP for local operation", () => {
    expect(withDirectGateway({}, LOCAL).env).toMatchObject({ ANTHROPIC_BASE_URL: LOCAL });
  });
  test("rejects insecure remote and credential-bearing gateway URLs", () => {
    for (const value of ["http://gateway.example.test/app", "https://user:pass@gateway.example.test/app", "https://gateway.example.test/app#fragment"]) {
      expect(() => withDirectGateway({}, value)).toThrow();
    }
  });
});

describe("folders", () => {
  test("configureDirectGateway writes settings.json 0600 and the folder then passes the check", async () => {
    const dir = await mkdtemp(join(root, "swap-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: LOCAL, HTTPS_PROXY: "https://proxy.example.test", NODE_EXTRA_CA_CERTS: "/ca.pem" } }));
    expect(await folderUsageProxyProblem(dir)).toBeDefined();
    await configureDirectGateway(dir, GATEWAY);
    expect(await folderUsageProxyProblem(dir)).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).env).toEqual({ ANTHROPIC_BASE_URL: GATEWAY, NODE_EXTRA_CA_CERTS: "/ca.pem" });
    expect((await stat(join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
  });
  test("direct gateway configuration adds user:profile to a gateway entry, and never touches a real login", async () => {
    const gw = await mkdtemp(join(root, "gw-"));
    await writeFile(join(gw, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_t", refreshToken: null, scopes: ["user:inference"] } }));
    await configureDirectGateway(gw, GATEWAY);
    expect(JSON.parse(await readFile(join(gw, ".credentials.json"), "utf8")).claudeAiOauth.scopes).toEqual(["user:inference", "user:profile"]);
    const real = await mkdtemp(join(root, "real-"));
    const login = JSON.stringify({ claudeAiOauth: { accessToken: "at-SYNTHETIC_FIXTURE", refreshToken: "rt-SYNTHETIC_FIXTURE", scopes: ["user:inference"] } });
    await writeFile(join(real, ".credentials.json"), login);
    await configureDirectGateway(real, GATEWAY);
    expect(await readFile(join(real, ".credentials.json"), "utf8")).toBe(login);
  });

  test("a folder with no settings gets one; an unreadable one is not reported", async () => {
    const dir = await mkdtemp(join(root, "t3-"));
    expect(await folderUsageProxyProblem(dir)).toBeUndefined();
    await configureDirectGateway(dir, GATEWAY);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
    await writeFile(join(dir, "settings.json"), "{not json");
    expect(await folderUsageProxyProblem(dir)).toBeUndefined();
  });
});
