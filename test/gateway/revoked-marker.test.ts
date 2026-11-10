import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlerter } from "../../src/gateway/alerts.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { instrumentRefresh } from "../../src/gateway/serve.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import { refreshFingerprint } from "../../src/identities/gateway-routed.ts";
import { readLoginRevoked, revokedMarkerPath } from "../../src/identities/gateway-revoked.ts";
import { OAuthRefreshError } from "../../src/identities/oauth-refresh.ts";

let root: string;
const saved = { dir: process.env.AIS_GATEWAY_MEMBERS_DIR, store: process.env.AIS_GATEWAY_MEMBER_STORE };

const login = (n: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x", access_token: `at-SYNTHETIC_FIXTURE-${n}`, refresh_token: `rt-SYNTHETIC_FIXTURE-${n}` } });
const fp = (n: string) => refreshFingerprint(`rt-SYNTHETIC_FIXTURE-${n}`).slice(0, 8);
const id = { name: "work", label: "work", configDir: "/unused" } as never;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-revoked-"));
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
  process.env.AIS_GATEWAY_MEMBER_STORE = "1";
  await mkdir(memberDir("codex", "work"), { recursive: true });
  await writeFile(join(memberDir("codex", "work"), "auth.json"), login("one"));
});
afterEach(async () => {
  for (const [k, v] of [["AIS_GATEWAY_MEMBERS_DIR", saved.dir], ["AIS_GATEWAY_MEMBER_STORE", saved.store]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

const wrap = (impl: () => Promise<unknown>) =>
  instrumentRefresh(impl as never, { metrics: new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 }), alerter: createAlerter(() => {}) });

describe("the gateway records a dead member login for the portal", () => {
  test("a dead-grant answer from the token endpoint writes a marker with no secret", async () => {
    const refresh = wrap(async () => {
      throw new OAuthRefreshError("token refresh rejected (HTTP 401 token_revoked)", true, fp("one"), "token_revoked");
    });
    await expect(refresh("codex", id, {})).rejects.toThrow();
    const marker = readLoginRevoked("codex", "work");
    expect(marker?.code).toBe("token_revoked");
    expect(await readFile(revokedMarkerPath("codex", "work"), "utf8")).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("an earlier diagnosis (skipped-revoked) writes it too", async () => {
    await wrap(async () => ({ tool: "codex", identity: "work", outcome: "skipped-revoked", beforeFingerprint: fp("one"), written: [], writeFailures: [] }))("codex", id, {});
    expect(readLoginRevoked("codex", "work")?.code).toBe("revoked");
  });

  test("a failure that is not a dead grant (network, other 400) writes nothing", async () => {
    await expect(wrap(async () => { throw new OAuthRefreshError("token endpoint unreachable", false); })("codex", id, {})).rejects.toThrow();
    await expect(wrap(async () => { throw new OAuthRefreshError("token refresh rejected (HTTP 400)", true, fp("one"), "invalid_request"); })("codex", id, {})).rejects.toThrow();
    expect(readLoginRevoked("codex", "work")).toBeUndefined();
  });

  test("nothing is written outside a member-store process", async () => {
    process.env.AIS_GATEWAY_MEMBER_STORE = "0";
    await expect(wrap(async () => { throw new OAuthRefreshError("rejected", true, fp("one"), "invalid_grant"); })("codex", id, {})).rejects.toThrow();
    expect(readLoginRevoked("codex", "work")).toBeUndefined();
  });

  test("the marker applies only to the login it was written for", async () => {
    await expect(wrap(async () => { throw new OAuthRefreshError("rejected", true, fp("one"), "refresh_token_reused"); })("codex", id, {})).rejects.toThrow();
    expect(readLoginRevoked("codex", "work")).toBeDefined();
    await writeFile(join(memberDir("codex", "work"), "auth.json"), login("two"));
    expect(readLoginRevoked("codex", "work")).toBeUndefined();
  });

  test("a portal login that lands before the marker is written is never marked", async () => {
    const refresh = wrap(async () => {
      // the rejection for login "one" is in flight; the owner signs in again before the gateway records it
      await writeFile(join(memberDir("codex", "work"), "auth.json"), login("two"));
      throw new OAuthRefreshError("token refresh rejected (HTTP 401 token_revoked)", true, fp("one"), "token_revoked");
    });
    await expect(refresh("codex", id, {})).rejects.toThrow();
    expect(readLoginRevoked("codex", "work")).toBeUndefined();
    await expect(readFile(revokedMarkerPath("codex", "work"), "utf8")).rejects.toThrow();
  });

  test("a rejection that names no grant writes nothing", async () => {
    await expect(wrap(async () => { throw new OAuthRefreshError("rejected", true, undefined, "token_revoked"); })("codex", id, {})).rejects.toThrow();
    expect(readLoginRevoked("codex", "work")).toBeUndefined();
  });
});
