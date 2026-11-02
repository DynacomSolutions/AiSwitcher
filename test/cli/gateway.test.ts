import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runGatewayCommand, type GatewayCliDeps } from "../../src/cli/gateway/dispatch.ts";
import { appendSecretsFile } from "../../src/cli/gateway/secrets-file.ts";
import { writeAppSecret } from "../../src/cli/gateway/kube-secret.ts";

const SCRATCH = resolve(import.meta.dir, "../../../../../../.data/DynacomSolutions/AiSwitcher/scratch/gw-t7-tests");
const TOKEN = "aisgw_TESTTOKEN0123456789abcdef";
let dir: string;
let secrets: string;
let out: string[];
let calls: { url: string; method: string; body?: unknown }[];
let kube: { args: string[]; stdin: string }[];
let respond: (url: string, method: string, body: unknown) => Response;

const run = (line: string, over: Partial<GatewayCliDeps> = {}) => {
  const { positionals, flags } = parseArgs(line.split(" ").filter(Boolean));
  return runGatewayCommand(positionals.slice(1), flags, {
    secretsPath: secrets,
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init.method ?? "GET", body });
      return respond(url, init.method ?? "GET", body);
    }) as unknown as typeof fetch,
    kubectl: async (args, stdin) => {
      kube.push({ args, stdin });
      return { code: 0, stderr: "" };
    },
    out: (s) => out.push(s),
    now: () => 1_700_000_000_000,
    ...over,
  });
};

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, "case-"));
  secrets = join(dir, "secrets");
  writeFileSync(secrets, "export AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN='adm-1'\nAIS_GATEWAY_PROXY_URL=https://gw.test\nOTHER=keep\n", { mode: 0o600 });
  out = [];
  calls = [];
  kube = [];
  respond = (url, method) => {
    if (method === "GET" && url.includes("/apps/")) return Response.json({ error: "no such app" }, { status: 404 });
    if (method === "PUT") return Response.json({ name: "billing" }, { status: 201 });
    if (url.endsWith("/tokens")) return Response.json({ app: "billing", token: TOKEN, prefix: "aisgw_TEST" }, { status: 201 });
    return Response.json({});
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ADD = "gateway app add billing --namespace=shop --provider=claude --pool";

describe("ais gateway app add", () => {
  test("add calls admin then writes secret then secrets file", async () => {
    await run(ADD);
    const order = calls.map((c) => `${c.method} ${c.url.replace("http://admin.test", "")}`);
    expect(order).toEqual(["GET /apps/billing", "PUT /apps/billing", "POST /apps/billing/tokens"]);
    const put = calls[1]!;
    expect(put.body).toMatchObject({ namespace: "shop", provider: "claude", style: "anthropic", target: { kind: "pool" } });
    expect(kube).toHaveLength(1);
    const manifest = JSON.parse(kube[0]!.stdin);
    expect(manifest.metadata).toMatchObject({ name: "ais-gateway-billing", namespace: "shop" });
    expect(manifest.stringData).toEqual({ AIS_GATEWAY_URL: "https://gw.test/billing", AIS_GATEWAY_USERNAME: "billing", AIS_GATEWAY_TOKEN: TOKEN });
    expect(readFileSync(secrets, "utf8")).toContain(`AIS_GATEWAY_APP_BILLING_TOKEN=${TOKEN}`);
  });

  test("token printed once and never in kubectl argv", async () => {
    await run(ADD);
    expect(out.join("\n").split(TOKEN)).toHaveLength(2);
    expect(kube[0]!.args.join(" ")).not.toContain(TOKEN);
    expect(kube[0]!.args).toContain("-f");
    expect(kube[0]!.args).toContain("-");
  });

  test("pin and pool flags are mutually exclusive", async () => {
    await expect(run(`${ADD} --identity=work`)).rejects.toThrow(/either --pool or --identity/);
    await expect(run("gateway app add billing --namespace=shop --provider=claude")).rejects.toThrow(/Choose a target/);
    expect(calls).toHaveLength(0);
  });

  test("style required for kimi and zai", async () => {
    await expect(run("gateway app add b --namespace=shop --provider=kimi --pool")).rejects.toThrow(/--style is required for kimi/);
    await expect(run("gateway app add b --namespace=shop --provider=zai --pool")).rejects.toThrow(/--style is required for zai/);
    await run("gateway app add billing --namespace=shop --provider=kimi --style=openai --pool");
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ style: "openai" });
  });

  test("surfaces the admin 400 reason", async () => {
    respond = (_u, m) => (m === "PUT" ? Response.json({ error: "reservePercent must be between 1 and 100" }, { status: 400 }) : Response.json({ error: "no such app" }, { status: 404 }));
    await expect(run(`${ADD} --reserve=0`)).rejects.toThrow("reservePercent must be between 1 and 100");
    expect(kube).toHaveLength(0);
  });

  test("refuses to overwrite an existing app", async () => {
    respond = () => Response.json({ name: "billing" });
    await expect(run(ADD)).rejects.toThrow(/already exists/);
  });

  test("a kubectl failure still saves the token locally and reports", async () => {
    await expect(run(ADD, { kubectl: async () => ({ code: 1, stderr: "forbidden" }) })).rejects.toThrow(/forbidden/);
    expect(readFileSync(secrets, "utf8")).toContain(TOKEN);
  });
});

describe("other commands", () => {
  test("rotate mints a token and rewrites the secret", async () => {
    respond = (url, m) => (m === "GET" ? Response.json({ name: "billing", namespace: "shop" }) : Response.json({ token: TOKEN, prefix: "aisgw_TEST" }, { status: 201 }));
    await run("gateway app rotate billing");
    expect(kube).toHaveLength(1);
    expect(out.join("\n")).toContain(TOKEN);
  });

  test("revoke posts to the admin API", async () => {
    respond = () => Response.json({ app: "billing", state: "revoked" });
    await run("gateway app revoke billing");
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://admin.test/apps/billing/revoke" });
  });

  test("update merges flags over the current app", async () => {
    respond = (_u, m) =>
      m === "GET"
        ? Response.json({ name: "billing", owner: "o", namespace: "shop", provider: "claude", style: "anthropic", target: { kind: "pool" }, state: "active", createdAt: "x", tokens: [] })
        : Response.json({ name: "billing" });
    await run("gateway app update billing --daily-tokens=5000 --identity=work");
    expect(calls[1]!.body).toEqual({ owner: "o", namespace: "shop", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "work" }, dailyTokens: 5000 });
  });

  test("usage renders a table and json", async () => {
    respond = () => Response.json({ usage: [{ app: "billing", provider: "claude", days: 7, tokens: 15 }] });
    await run("gateway usage --days=7 --app=billing");
    expect(calls[0]!.url).toBe("http://admin.test/usage?days=7&app=billing");
    expect(out.join("\n")).toContain("billing");
    out = [];
    await run("gateway usage --json");
    expect(JSON.parse(out.join("\n")).usage).toHaveLength(1);
  });
});

describe("appendSecretsFile", () => {
  test("secrets file backup made and mode 0600", async () => {
    await appendSecretsFile("K", "v", secrets, 1234);
    expect(readdirSync(dir)).toContain("secrets.bak.1234");
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "secrets.bak.1234")).mode & 0o777).toBe(0o600);
  });

  test("existing key replaced not duplicated", async () => {
    await appendSecretsFile("K", "one", secrets, 1);
    await appendSecretsFile("K", "two", secrets, 2);
    const text = readFileSync(secrets, "utf8");
    expect(text.match(/^K=/gm)).toHaveLength(1);
    expect(text).toContain("K=two");
    expect(text).toContain("OTHER=keep");
  });

  test("creates a missing file with mode 0600", async () => {
    const p = join(dir, "fresh");
    await appendSecretsFile("K", "v", p, 1);
    expect(readFileSync(p, "utf8")).toBe("K=v\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("writeAppSecret", () => {
  test("passes the manifest via stdin only", async () => {
    let seen: { args: string[]; stdin: string } | undefined;
    await writeAppSecret("ns", "app", { url: "u", username: "app", token: TOKEN }, async (args, stdin) => {
      seen = { args, stdin };
      return { code: 0, stderr: "" };
    });
    expect(seen!.args.join(" ")).not.toContain(TOKEN);
    expect(seen!.stdin).toContain(TOKEN);
  });
});
