import { describe, expect, test } from "bun:test";
import { combineAuthRows, readAuthParams, visibleAuthRows, withAuthParam } from "../../apps/web/src/lib/auth-list.ts";
import type { AuthEntry, RenewalRow } from "../../apps/web/src/types/api.ts";

const NOW = Date.parse("2026-11-27T06:00:00.000Z");
const entry = (toolName: AuthEntry["toolName"], identity: string, over: Partial<AuthEntry> = {}): AuthEntry => ({ toolName, identity, kind: "oauth", state: "ok", fixable: ["login"], ...over });
const gw = (tool: string, identity: string, over: Partial<NonNullable<RenewalRow["gateway"]>> = {}): RenewalRow => ({
  tool, identity, renewer: "gateway", note: "", host: null,
  gateway: { provider: tool, identity, lastRefreshAt: "2026-11-27T04:00:00.000Z", lastRefreshReplica: null, lastError: null, expiresAt: "2026-11-27T12:00:00.000Z", nextRefreshAt: "2026-11-27T08:00:00.000Z", revoked: false, ...over },
});

const ENTRIES = [
  entry("codex", "b-codex"),
  entry("claude", "a-claude", { expiresAt: "2026-11-27T09:00:00.000Z" }),
  entry("codex", "c-dead", { state: "expired" }),
  entry("zai", "d-key", { kind: "apikey", fixable: ["zai-key"] }),
  entry("codex", "e-old", { state: "retired" }),
];
const RENEWALS = [
  gw("codex", "b-codex"),
  gw("claude", "a-claude", { expiresAt: "2026-11-27T09:00:00.000Z", nextRefreshAt: "2026-11-27T07:00:00.000Z" }),
  gw("codex", "c-dead", { revoked: true, expiresAt: null, nextRefreshAt: null, lastError: { at: "2026-11-26T22:53:00.000Z", code: "refresh_token_invalidated", detail: "dead" } }),
  gw("grok", "f-renewal-only"),
];
const rows = combineAuthRows(ENTRIES, RENEWALS, NOW);
const keys = (r: { key: string }[]) => r.map((x) => x.key);

describe("combineAuthRows", () => {
  test("one row per identity and tool, with a renewal-only key kept and retired last", () => {
    expect(keys(rows)).toEqual(["codex/b-codex", "claude/a-claude", "codex/c-dead", "zai/d-key", "grok/f-renewal-only", "codex/e-old"]);
  });
  test("a healthy gateway login shows expiry, last and next renewal and who renews it", () => {
    expect(rows[0]).toMatchObject({ expires: "in 6h", lastRenewal: "2h ago", nextRenewal: "in 2h", renewedBy: "Gateway", error: null, attention: false });
  });
  test("a revoked login needs attention and shows its last error", () => {
    const dead = rows.find((r) => r.key === "codex/c-dead")!;
    expect(dead.attention).toBe(true);
    expect(dead.error).toContain("refresh_token_invalidated");
    expect(dead.nextRenewal).toBe("-");
  });
  test("a login with no renewal row shows dashes, never a made-up renewal", () => {
    expect(rows.find((r) => r.key === "zai/d-key")).toMatchObject({ lastRenewal: "-", nextRenewal: "-", renewedBy: "-", error: null, attention: false });
  });
  test("a retired identity never needs attention", () => {
    expect(rows.find((r) => r.key === "codex/e-old")).toMatchObject({ retired: true, attention: false });
  });
});

describe("renewal information on each row", () => {
  const host = (tool: string, identity: string, over: Partial<NonNullable<RenewalRow["host"]>> = {}): RenewalRow => ({
    tool, identity, renewer: "host", gateway: null, note: "",
    host: { lastAttemptAt: "2026-11-27T05:00:00.000Z", lastSuccessAt: "2026-11-27T05:00:00.000Z", lastError: null, lastDetail: null, revoked: false, consecutiveFailures: 0, running: false, ...over },
  });
  const make = (entries: AuthEntry[], renewals: RenewalRow[]) => combineAuthRows(entries, renewals, NOW);
  test("each row carries its kind and its renewal status label", () => {
    expect(rows.find((r) => r.key === "codex/b-codex")).toMatchObject({ kind: "oauth", status: { tone: "ok", label: "Renewing" } });
    expect(rows.find((r) => r.key === "codex/c-dead")).toMatchObject({ status: { tone: "destructive", label: "Sign-in needed" } });
    expect(rows.find((r) => r.key === "zai/d-key")).toMatchObject({ kind: "apikey", status: null });
    expect(rows.find((r) => r.key === "grok/f-renewal-only")).toMatchObject({ kind: null });
  });
  test("the status label covers a failed refresh, repeated failures, a missing admin and a pool", () => {
    const list = make(
      [entry("claude", "pool-a", { kind: "none", state: "gateway" })],
      [
        gw("codex", "failed", { lastError: { at: "2026-11-27T05:30:00.000Z", code: "transport", detail: "x" } }),
        host("kimi", "three", { consecutiveFailures: 3, lastError: "boom" }),
        host("kimi", "detail", { lastDetail: "kept fresh by another host" }),
        { tool: "grok", identity: "no-admin", renewer: "gateway", gateway: null, gatewayState: "unconfigured", note: "", host: null },
        { tool: "claude", identity: "pool-a", renewer: "pool", gateway: null, note: "", host: null },
      ],
    );
    const label = (key: string) => list.find((r) => r.key === key)?.status?.label;
    expect(label("codex/failed")).toBe("Last refresh failed");
    expect(label("kimi/three")).toBe("3 failures in a row");
    expect(label("kimi/detail")).toBe("kept fresh by another host");
    expect(label("grok/no-admin")).toBe("Gateway admin not set up here");
    expect(label("claude/pool-a")).toBe("Members renewed by the gateway");
  });
  test("the probe detail shows for a healthy row and not for a retired row", () => {
    const list = make([entry("codex", "ok-one", { detail: "via gateway: renewed" }), entry("codex", "old", { state: "retired", detail: "retired" })], []);
    expect(list.find((r) => r.key === "codex/ok-one")?.detail).toBe("via gateway: renewed");
    expect(list.find((r) => r.key === "codex/old")?.detail).toBeNull();
  });
  test("the text filter finds a status label", () => {
    expect(keys(visibleAuthRows(rows, readAuthParams(new URLSearchParams("q=sign-in needed"))))).toEqual(["codex/c-dead"]);
  });
});

describe("URL state", () => {
  test("an empty URL reads the defaults", () => {
    expect(readAuthParams(new URLSearchParams(""))).toEqual({ q: "", tool: "", state: "all", sort: "default", dir: "asc" });
  });
  test("an unknown value falls back to the default", () => {
    expect(readAuthParams(new URLSearchParams("sort=nope&state=weird&dir=sideways"))).toMatchObject({ sort: "default", state: "all", dir: "asc" });
  });
  test("an unknown tool reads as all tools once the tools are known", () => {
    expect(readAuthParams(new URLSearchParams("tool=nope&sort=tool"), ["claude", "codex"])).toMatchObject({ tool: "", sort: "tool" });
    expect(readAuthParams(new URLSearchParams("tool=codex"), ["claude", "codex"]).tool).toBe("codex");
    expect(withAuthParam(new URLSearchParams("tool=nope&sort=tool"), "tool", "").toString()).toBe("sort=tool");
  });
  test("a default value leaves no key and the other keys stay", () => {
    const p = withAuthParam(new URLSearchParams("tool=codex&sort=expires&dir=desc"), "sort", "default");
    expect(p.toString()).toBe("tool=codex");
    expect(withAuthParam(new URLSearchParams("tool=codex"), "q", "dead").toString()).toBe("tool=codex&q=dead");
    expect(withAuthParam(new URLSearchParams("state=ok"), "state", "all").toString()).toBe("");
  });
});

describe("visibleAuthRows", () => {
  const view = (q: string) => visibleAuthRows(rows, readAuthParams(new URLSearchParams(q)));
  test("the default order keeps the list order", () => {
    expect(keys(view(""))).toEqual(keys(rows));
  });
  test("the tool filter and the text filter narrow the list", () => {
    expect(keys(view("tool=codex"))).toEqual(["codex/b-codex", "codex/c-dead", "codex/e-old"]);
    expect(keys(view("q=invalidated"))).toEqual(["codex/c-dead"]);
  });
  test("the attention filter keeps only what needs a person", () => {
    // A key with a renewal row but no auth probe has an unknown state: a person should look.
    expect(keys(view("state=attention"))).toEqual(["codex/c-dead", "grok/f-renewal-only"]);
    expect(keys(view("state=ok"))).toEqual(["codex/b-codex", "claude/a-claude", "zai/d-key"]);
  });
  test("sort by expiry puts the soonest first and a missing expiry last, in both directions", () => {
    expect(keys(view("sort=expires"))).toEqual(["claude/a-claude", "codex/b-codex", "grok/f-renewal-only", "codex/c-dead", "zai/d-key", "codex/e-old"]);
    expect(keys(view("sort=expires&dir=desc")).slice(-3)).toEqual(["codex/c-dead", "zai/d-key", "codex/e-old"]);
  });
  test("sort by state puts the worst first", () => {
    expect(keys(view("sort=state"))[0]).toBe("codex/c-dead");
  });
});
