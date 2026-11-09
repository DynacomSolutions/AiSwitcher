import { describe, expect, test } from "bun:test";
import { createAlerter } from "../../src/gateway/alerts.ts";
import { aliSessionOnce, aliSetupProblems, aliSetupSelfTest, listAliAccounts } from "../../src/gateway/ali-session.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { AliAuthRefreshError } from "../../src/identities/auth-session.ts";
import type { Identity } from "../../src/identities/types.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = (name: string): Identity => ({ name, label: name, configDir: `/x/${name}` }) as Identity;

function setup() {
  const alerts: string[] = [];
  const alerter = createAlerter((a) => void alerts.push(`${a.kind} ${a.key}: ${a.message}`));
  const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  return { alerts, alerter, metrics };
}

describe("gateway-owned ali session renewal", () => {
  test("renews every live ali login and counts it", async () => {
    const { alerter, metrics } = setup();
    const done: string[] = [];
    await aliSessionOnce({ accounts: async () => [id("personal"), id("team")], refresh: async (i) => (done.push(i.name), "/x/console-cookie.txt"), metrics, alerter });
    expect(done).toEqual(["personal", "team"]);
    expect(metrics.render()).toContain('ais_gateway_keepalive_total{provider="ali",outcome="refreshed"} 2');
  });

  test("a login renewed within the interval is left alone, then renewed again after it", async () => {
    const { alerter, metrics } = setup();
    let t = Date.parse("2026-11-02T10:00:00Z");
    const now = (): Date => new Date(t);
    const lastSuccess = new Map<string, string>();
    let runs = 0;
    const deps = { accounts: async () => [id("personal")], refresh: async () => (runs++, "p"), metrics, alerter, lastSuccess, now };
    await aliSessionOnce(deps);
    t += 5 * 60_000;
    await aliSessionOnce(deps);
    expect(runs).toBe(1);
    t += 6 * 60_000;
    await aliSessionOnce(deps);
    expect(runs).toBe(2);
    expect(metrics.render()).toContain('outcome="skipped-fresh"');
  });

  test("a failure alerts once with the fix, never throws, and a later success clears it", async () => {
    const { alerts, alerter, metrics } = setup();
    let fail = true;
    const deps = {
      accounts: async () => [id("personal")],
      refresh: async () => {
        if (fail) throw new AliAuthRefreshError("not signed in", undefined, "not-signed-in");
        return "p";
      },
      metrics,
      alerter,
    };
    await aliSessionOnce(deps);
    await aliSessionOnce(deps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("refresh-failed ali/personal");
    expect(alerts[0]).toContain("ais auth login personal --tool=ali");
    expect(metrics.render()).toContain('ais_gateway_keepalive_total{provider="ali",outcome="failed"} 2');
    fail = false;
    await aliSessionOnce(deps);
    fail = true;
    await aliSessionOnce(deps);
    expect(alerts).toHaveLength(2); // the alert re-armed after the success
  });

  test("an unreadable account list renews nothing", async () => {
    const { alerter, metrics } = setup();
    let runs = 0;
    await aliSessionOnce({ accounts: async () => Promise.reject(new Error("no registry")), refresh: async () => (runs++, "p"), metrics, alerter });
    expect(runs).toBe(0);
  });

  test("listAliAccounts drops retired logins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ali-reg-"));
    const path = join(dir, "identities.json");
    await writeFile(path, JSON.stringify({ version: 1, identities: [{ name: "live", label: "live", configDir: "/a" }, { name: "gone", label: "gone", configDir: "/b", retired: true }] }));
    const names = (await listAliAccounts(path)).map((i) => i.name);
    expect(names).toContain("live");
    expect(names).not.toContain("gone");
    expect(await listAliAccounts(join(dir, "missing.json"))).toEqual([]);
  });
});

describe("cadence", () => {
  test("a renewal that takes seconds still runs on every 10-minute tick", async () => {
    const { alerter, metrics } = setup();
    let t = 0;
    const now = (): Date => new Date(t);
    const lastSuccess = new Map<string, string>();
    let runs = 0;
    for (let pass = 0; pass < 6; pass++) {
      t = pass * 600_000 + 2_000; // the tick, after the OAuth pass
      await aliSessionOnce({ accounts: async () => [id("a")], refresh: async () => ((t += 6_000), runs++, "ok"), metrics, alerter, lastSuccess, now });
    }
    expect(runs).toBe(6);
  });

  test("timer jitter of under a minute does not skip a renewal", async () => {
    const { alerter, metrics } = setup();
    let t = 0;
    const lastSuccess = new Map<string, string>();
    let runs = 0;
    const deps = { accounts: async () => [id("a")], refresh: async () => (runs++, "ok"), metrics, alerter, lastSuccess, now: () => new Date(t) };
    await aliSessionOnce(deps);
    t = 600_000 - 30_000;
    await aliSessionOnce(deps);
    expect(runs).toBe(2);
  });
});

describe("cadence with a long renewal", () => {
  test("a renewal that takes two minutes is still renewed on every tick (timestamp taken at the start)", async () => {
    const { alerter, metrics } = setup();
    let t = 0;
    const lastSuccess = new Map<string, string>();
    let runs = 0;
    for (let pass = 0; pass < 4; pass++) {
      t = pass * 600_000 + 2_000;
      await aliSessionOnce({ accounts: async () => [id("a")], refresh: async () => ((t += 120_000), runs++, "ok"), metrics, alerter, lastSuccess, now: () => new Date(t) });
    }
    expect(runs).toBe(4);
  });
});

describe("shutdown", () => {
  test("an abort ends a renewal that never finishes, and stops the pass", async () => {
    const { alerter, metrics } = setup();
    const ctrl = new AbortController();
    const started: string[] = [];
    const run = aliSessionOnce({ accounts: async () => [id("a"), id("b")], refresh: (i) => (started.push(i.name), new Promise<string>(() => {})), metrics, alerter, signal: ctrl.signal });
    await Bun.sleep(10);
    ctrl.abort();
    await run;
    expect(started).toEqual(["a"]);
    expect(metrics.render()).toContain('outcome="aborted"');
  });
});

describe("what a person is told", () => {
  test("a busy shared browser is retried quietly", async () => {
    const { alerts, alerter, metrics } = setup();
    await aliSessionOnce({ accounts: async () => [id("a")], refresh: async () => Promise.reject(new AliAuthRefreshError("busy", "x", "busy")), metrics, alerter });
    expect(alerts).toEqual([]);
  });

  test("a person on the sign-in page is left alone, and only alerted after three skipped passes", async () => {
    const { alerts, alerter, metrics } = setup();
    const loginPageSkips = new Map<string, number>();
    const deps = { accounts: async () => [id("a")], refresh: async () => Promise.reject(new AliAuthRefreshError("signing in", "x", "login-in-progress")), metrics, alerter, loginPageSkips };
    await aliSessionOnce(deps);
    await aliSessionOnce(deps);
    expect(alerts).toEqual([]);
    await aliSessionOnce(deps);
    expect(alerts).toHaveLength(1);
  });

  test("the fix names only commands that exist where the gateway runs", async () => {
    const { alerts, alerter, metrics } = setup();
    await aliSessionOnce({ accounts: async () => [id("a")], refresh: async () => Promise.reject(new AliAuthRefreshError("down", "check kubectl port-forward (ais auth ports)", "browser-unreachable")), metrics, alerter });
    expect(alerts[0]).toContain("AIS_K8S_API_SERVER");
    expect(alerts[0]).not.toContain("ais auth ports");
  });
});

describe("startup self-test", () => {
  const ok = { accounts: async () => [id("a")], which: () => "/bin/x", env: { AIS_K8S_API_SERVER: "https://k" }, writable: async () => true, canPortForward: async () => true };

  test("nothing missing, nothing alerted; no ali login, nothing checked", async () => {
    const { alerts, alerter } = setup();
    expect(await aliSetupSelfTest(alerter, ok)).toEqual([]);
    expect(await aliSetupSelfTest(alerter, { ...ok, accounts: async () => [], which: () => null })).toEqual([]);
    expect(alerts).toEqual([]);
  });

  test("every missing piece is named in one alert", async () => {
    const { alerts, alerter } = setup();
    const problems = await aliSetupSelfTest(alerter, { ...ok, which: (c: string) => (c === "kubectl" ? null : null), writable: async () => false });
    expect(problems.join(" ")).toContain("kubectl is not on");
    expect(problems.join(" ")).toContain("auth-browser state directory");
    expect(problems.join(" ")).toContain('identity directory for "a"');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("ali-setup-missing ali");
  });

  test("missing in-pod API address and port-forward permission", async () => {
    const problems = await aliSetupProblems({ ...ok, which: (c: string) => (c === "kubectl" ? "/bin/kubectl" : null), env: {}, canPortForward: async () => false });
    expect(problems.join(" ")).toContain("AIS_K8S_API_SERVER");
    expect(problems.join(" ")).toContain("pods/portforward");
  });
});
