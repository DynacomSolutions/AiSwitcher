import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runGatewayCommand, type GatewayCliDeps } from "../../src/cli/gateway/dispatch.ts";
import { appendSecretsFile } from "../../src/cli/gateway/secrets-file.ts";
import { writeAppSecret } from "../../src/cli/gateway/kube-secret.ts";

// Scratch lives in AIS_TEST_SCRATCH_DIR, or in the repo-local test/gateway/.tmp (gitignored).
const SCRATCH = process.env.AIS_TEST_SCRATCH_DIR ? join(process.env.AIS_TEST_SCRATCH_DIR, "gw-t7-cli") : join(import.meta.dir, "..", "gateway", ".tmp", "gw-t7-cli");
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
    codexHomesPath: join(dir, "codex-homes.json"),
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

describe("pool name as pinned identity", () => {
  const isPoolName = async (_p: string, n: string) => n === "shared-pool";
  const PIN = "gateway app add billing --namespace=shop --provider=claude";

  test("add rejects a pool name before any write", async () => {
    await expect(run(`${PIN} --identity=shared-pool`, { isPoolName })).rejects.toThrow(/--pool --identities=<members>/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("update rejects a pool name", async () => {
    respond = (url, method) => (method === "GET" ? Response.json({ owner: "o", namespace: "shop", provider: "claude", style: "anthropic", target: { kind: "pool" } }) : Response.json({}));
    await expect(run("gateway app update billing --identity=shared-pool", { isPoolName })).rejects.toThrow(/swap pool/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a real identity or alias is accepted", async () => {
    await run(`${PIN} --identity=real-account`, { isPoolName });
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ target: { kind: "pin", identity: "real-account" } });
  });
});

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
    expect(kube[0]!.args).toEqual(["apply", "--server-side", "--field-manager=ais-gateway", "--force-conflicts", "-f", "-"]);
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

  test("no proxy url errors before any token is minted", async () => {
    writeFileSync(secrets, "AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN=adm-1\n", { mode: 0o600 });
    delete process.env.AIS_GATEWAY_PROXY_URL;
    await expect(run(ADD)).rejects.toThrow(/Proxy base URL/);
    expect(calls.filter((c) => c.url.endsWith("/tokens"))).toHaveLength(0);
  });

  test("existing app message points to update and rotate", async () => {
    respond = () => Response.json({ name: "billing" });
    await expect(run(ADD)).rejects.toThrow(/update billing.*rotate billing/);
  });

  test("missing token in admin response writes nothing", async () => {
    respond = (url, m) => (m === "GET" ? Response.json({}, { status: 404 }) : url.endsWith("/tokens") ? Response.json({ app: "billing" }, { status: 201 }) : Response.json({}, { status: 201 }));
    const before = readFileSync(secrets, "utf8");
    await expect(run(ADD)).rejects.toThrow(/no token/);
    expect(kube).toHaveLength(0);
    expect(readFileSync(secrets, "utf8")).toBe(before);
  });

  test("kubectl message is redacted and both failures are reported", async () => {
    const bad = join(dir, "isdir");
    mkdirSync(bad);
    // Admin settings come from the environment here, since the secrets path is the broken one.
    Object.assign(process.env, { AIS_GATEWAY_ADMIN_URL: "http://admin.test", AIS_GATEWAY_ADMIN_TOKEN: "adm-1", AIS_GATEWAY_PROXY_URL: "https://gw.test" });
    const err = await run(ADD, { secretsPath: bad, kubectl: async () => ({ code: 1, stderr: `boom ${TOKEN}` }) }).catch((e: Error) => e);
    for (const k of ["AIS_GATEWAY_ADMIN_URL", "AIS_GATEWAY_ADMIN_TOKEN", "AIS_GATEWAY_PROXY_URL"]) delete process.env[k];
    expect(String(err)).not.toContain(TOKEN);
    expect(String(err)).toContain("boom [redacted]");
    expect(String(err)).toMatch(/secrets file/i);
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

  test("backup of a 0644 file is 0600", async () => {
    chmodSync(secrets, 0o644);
    await appendSecretsFile("K", "v", secrets, 7);
    expect(statSync(join(dir, "secrets.bak.7")).mode & 0o777).toBe(0o600);
  });

  test("an unreadable path throws and changes nothing", async () => {
    const d = join(dir, "adir");
    mkdirSync(d);
    await expect(appendSecretsFile("K", "v", d, 1)).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.startsWith("adir."))).toEqual([]);
    expect(statSync(d).isDirectory()).toBe(true);
  });

  test("a symlink is written through to its target", async () => {
    const link = join(dir, "link");
    symlinkSync(secrets, link);
    await appendSecretsFile("K", "v", link, 3);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(secrets, "utf8")).toContain("K=v");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  test("a dangling symlink is refused and left alone", async () => {
    const link = join(dir, "dangling");
    symlinkSync(join(dir, "nowhere"), link);
    await expect(appendSecretsFile("K", "v", link, 1)).rejects.toThrow(/dangling|symlink/i);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("an existing backup name is not overwritten", async () => {
    writeFileSync(`${secrets}.bak.5`, "old");
    await appendSecretsFile("K", "v", secrets, 5);
    expect(readFileSync(`${secrets}.bak.5`, "utf8")).toBe("old");
    expect(readdirSync(dir).filter((f) => f.startsWith("secrets.bak.5")).length).toBe(2);
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

describe("codex homes", () => {
  const CFG = `model_provider = "ais-gateway"\n\n[model_providers.ais-gateway]\nbase_url = "https://gw.test/billing"\n\n[model_providers.ais-gateway.auth]\ncommand = "printf"\n`;
  let home: string;
  const accessToken = () => JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.access_token;
  beforeEach(() => {
    home = join(dir, "codex-home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), CFG);
    writeFileSync(secrets, `${readFileSync(secrets, "utf8")}AIS_GATEWAY_APP_BILLING_TOKEN=aisgw_OLD_SYNTHETIC_FIXTURE\n`);
  });

  test("codex-home --check reports and writes nothing", async () => {
    await expect(run(`gateway codex-home ${home} --check`)).rejects.toThrow(/1 folder/);
    expect(out.join("\n")).toContain("config.toml needs");
    expect(() => statSync(join(home, "auth.json"))).toThrow();
  });

  test("codex-home configures, registers; check then passes", async () => {
    await run(`gateway codex-home ${home}`);
    expect(accessToken()).toBe("aisgw_OLD_SYNTHETIC_FIXTURE");
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("chatgpt_base_url = \"https://gw.test/billing/backend-api\"");
    expect(out.join("\n")).not.toContain("OLD_SYNTHETIC");
    await run(`gateway codex-home ${home} --check`);
  });

  test("codex-home on a local-route pool folder uses the agents-codex key and the local route", async () => {
    writeFileSync(join(home, "config.toml"), 'model_provider = "ais-gateway"\n\n[model_providers.ais-gateway]\nbase_url = "http://127.0.0.1:47140/codex"\nwire_api = "responses"\n');
    writeFileSync(join(home, "auth.json"), `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "aisg_SYNTHETIC_FIXTURE_old" })}\n`);
    writeFileSync(secrets, `${readFileSync(secrets, "utf8")}AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN=aisgw_AGENTS_SYNTHETIC_FIXTURE\n`);
    await run(`gateway codex-home ${home} --check`).then(() => {
      throw new Error("expected --check to fail before configuring");
    }, () => undefined);
    await run(`gateway codex-home ${home}`);
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    expect(auth.tokens).toMatchObject({ access_token: "aisgw_AGENTS_SYNTHETIC_FIXTURE", account_id: "ais-agents-codex" });
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('chatgpt_base_url = "http://127.0.0.1:47140/codex/backend-api"');
    expect(JSON.parse(readFileSync(join(dir, "codex-homes.json"), "utf8"))).toEqual([{ dir: home, app: "agents-codex" }]);
    await run(`gateway codex-home ${home} --check`);
    expect(out.join("\n")).not.toContain("AGENTS_SYNTHETIC");
  });

  test("codex-home without a token in secrets is skipped and fails", async () => {
    writeFileSync(secrets, "OTHER=1\n");
    await expect(run(`gateway codex-home ${home}`)).rejects.toThrow(/not configured/);
    expect(() => statSync(join(home, "auth.json"))).toThrow();
  });

  test("rotate rewrites registered homes and never prints the token twice", async () => {
    await run(`gateway codex-home ${home}`);
    out = [];
    respond = (url, method) => {
      if (method === "GET") return Response.json({ namespace: "shop" });
      return Response.json({ token: TOKEN, previousTokensExpireAt: "later" }, { status: 201 });
    };
    await run("gateway app rotate billing");
    expect(accessToken()).toBe(TOKEN);
    expect(out.join("\n")).toContain("auth.json rewritten in 1 registered folder(s)");
    expect(out.join("\n").split(TOKEN)).toHaveLength(2);
  });

  test("a failing home does not lose the token message", async () => {
    await run(`gateway codex-home ${home}`);
    rmSync(home, { recursive: true });
    out = [];
    respond = (url, method) => (method === "GET" ? Response.json({ namespace: "shop" }) : Response.json({ token: TOKEN }, { status: 201 }));
    await run("gateway app rotate billing");
    expect(out.join("\n")).toContain(`token (shown once): ${TOKEN}`);
    expect(out.join("\n")).toContain("codex homes: not updated");
  });
});
