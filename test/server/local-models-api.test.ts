import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";

const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
const headers = { Host: "127.0.0.1:47129" };
const dto = { online: false, runner: null, models: [{ name: "tiny", path: "/m/tiny.gguf", sizeBytes: 12 }] };
const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, ...extra });

describe("GET /api/local-models", () => {
  test("returns the DTO", async () => {
    const res = await appWith({ localModels: async () => dto }).request("/api/local-models", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dto);
  });

  test("still requires the console guard", async () => {
    const app = appWith({ localModels: async () => dto, peerAddress: "203.0.113.9" });
    expect((await app.request("/api/local-models", { headers })).status).toBe(401);
    expect((await app.request("/api/local-models", { headers: { Host: "evil.example" } })).status).toBe(403);
  });

  test("a probe that throws reports online: false rather than 500", async () => {
    // Default wiring with an unreachable probe URL: isOnline must not surface as a 500.
    const prev = { ...process.env };
    const home = mkdtempSync(join(tmpdir(), "ais-lm-api-"));
    process.env.HOME = home;
    process.env.AIS_LOCAL_MODELS_DIR = join(home, "none");
    process.env.AIS_ONLINE_PROBE_URL = "http://127.0.0.1:1";
    try {
      const res = await appWith({}).request("/api/local-models", { headers });
      expect(res.status).toBe(200);
      expect((await res.json() as { online: boolean }).online).toBe(false);
    } finally {
      for (const k of ["HOME", "AIS_LOCAL_MODELS_DIR", "AIS_ONLINE_PROBE_URL"]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
