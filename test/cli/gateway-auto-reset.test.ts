import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGatewayCommand } from "../../src/cli/gateway/dispatch.ts";
import { AUTO_RESET_PATH, autoResetProviderPath, type AutoResetView } from "../../src/gateway/auto-reset-view.ts";

const VIEW: AutoResetView = {
  providers: [
    { provider: "codex", supported: true, memberClaims: {}, pools: [{ name: "test-pool", enabled: false, members: ["test-member"] }] },
    { provider: "claude", supported: true, memberClaims: {}, pools: [{ name: "claude-fixture-pool", enabled: true, members: ["claude-member"] }, { name: "shared-pool", enabled: false, members: [] }] },
    { provider: "kimi", supported: false, reason: "This provider has no reset credit or grant API." },
  ],
};

async function withCli(run: (ctx: { deps: object; calls: Array<{ path: string; method: string; body?: unknown }>; output: string[] }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ais-auto-reset-cli-"));
  try {
    const secretsPath = join(dir, "secrets");
    const admin = "admin_SYNTHETIC_FIXTURE";
    await writeFile(secretsPath, `AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN=${admin}\n`, { mode: 0o600 });
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const output: string[] = [];
    const deps = {
      secretsPath,
      out: (line: string) => output.push(line),
      fetch: (async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${admin}`);
        const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ path: new URL(url).pathname, method: init.method!, ...(body ? { body } : {}) });
        return Response.json(body ?? VIEW);
      }) as typeof fetch,
    };
    await run({ deps, calls, output });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("gateway auto-reset CLI lists every provider and sets a pool with the admin bearer", async () => {
  await withCli(async ({ deps, calls, output }) => {
    await expect(runGatewayCommand(["auto-reset", "set", "pool", "test-pool", "yes"], {}, deps)).rejects.toThrow("Usage:");
    await runGatewayCommand(["auto-reset", "list"], {}, deps);
    await runGatewayCommand(["auto-reset", "set", "pool", "test-pool", "on"], {}, deps);
    await runGatewayCommand(["auto-reset", "set", "pool", "claude-fixture-pool", "off"], {}, deps);
    await runGatewayCommand(["auto-reset", "set", "pool", "shared-pool", "on"], { provider: "claude" }, deps);

    expect(calls).toEqual([
      { path: AUTO_RESET_PATH, method: "GET" },
      { path: AUTO_RESET_PATH, method: "GET" },
      { path: `${autoResetProviderPath("codex")}/pool`, method: "PUT", body: { name: "test-pool", enabled: true } },
      { path: AUTO_RESET_PATH, method: "GET" },
      { path: `${autoResetProviderPath("claude")}/pool`, method: "PUT", body: { name: "claude-fixture-pool", enabled: false } },
      { path: `${autoResetProviderPath("claude")}/pool`, method: "PUT", body: { name: "shared-pool", enabled: true } },
    ]);
    expect(output).toEqual([
      "codex pool test-pool  automatic reset off, last claim: none",
      "claude pool claude-fixture-pool  automatic reset on, last claim: none",
      "claude pool shared-pool  automatic reset off, last claim: none",
      "kimi  automatic reset is not supported: This provider has no reset credit or grant API.",
      "codex pool test-pool  automatic reset on",
      "claude pool claude-fixture-pool  automatic reset off",
      "claude pool shared-pool  automatic reset on",
    ]);
  });
});

test("gateway auto-reset CLI has no identity form and sends nothing for it", async () => {
  await withCli(async ({ deps, calls }) => {
    await expect(runGatewayCommand(["auto-reset", "set", "identity", "test-member", "on"], {}, deps))
      .rejects.toThrow("pool setting only");
    expect(calls).toEqual([]);
  });
});

test("gateway auto-reset CLI refuses an unknown provider flag and a pool name that two providers share", async () => {
  await withCli(async ({ deps, calls }) => {
    await expect(runGatewayCommand(["auto-reset", "set", "pool", "test-pool", "on"], { provider: "kimi" }, deps)).rejects.toThrow("no reset API");
    await expect(runGatewayCommand(["auto-reset", "set", "pool", "no-such-pool", "on"], {}, deps)).rejects.toThrow("No pool named");
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
  });
});
