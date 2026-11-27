import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGatewayCommand } from "../../src/cli/gateway/dispatch.ts";
import { CODEX_AUTO_RESET_PATH as PATH } from "../../src/gateway/auto-reset-view.ts";

test("gateway auto-reset CLI lists and changes state with the admin bearer", async () => {
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
        return Response.json(body ?? { pools: [{ name: "test-pool", enabled: false, members: ["test-member"] }], identities: [] });
      }) as typeof fetch,
    };

    await expect(runGatewayCommand(["auto-reset", "set", "pool", "test-pool", "yes"], {}, deps)).rejects.toThrow("Usage:");
    await runGatewayCommand(["auto-reset", "list"], {}, deps);
    await runGatewayCommand(["auto-reset", "set", "pool", "test-pool", "on"], {}, deps);
    await expect(runGatewayCommand(["auto-reset", "set", "identity", "test-member", "off"], {}, deps)).rejects.toThrow("Usage:");
    await runGatewayCommand(["auto-reset", "set", "pool", "test-pool", "off"], {}, deps);
    await runGatewayCommand(["auto-reset", "list"], { json: true }, deps);

    expect(calls).toEqual([
      { path: PATH, method: "GET" },
      { path: `${PATH}/pool`, method: "PUT", body: { name: "test-pool", enabled: true } },
      { path: `${PATH}/pool`, method: "PUT", body: { name: "test-pool", enabled: false } },
      { path: PATH, method: "GET" },
    ]);
    expect(output.slice(0, 3)).toEqual([
      "pool test-pool  automatic reset off, last claim: none",
      "pool test-pool  automatic reset on",
      "pool test-pool  automatic reset off",
    ]);
    expect(JSON.parse(output[3]!)).toEqual({ pools: [{ name: "test-pool", enabled: false, members: ["test-member"] }] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
