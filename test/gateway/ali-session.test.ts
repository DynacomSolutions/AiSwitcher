import { describe, expect, test } from "bun:test";
import { createAlerter } from "../../src/gateway/alerts.ts";
import { aliSessionOnce, listAliAccounts } from "../../src/gateway/ali-session.ts";
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
        if (fail) throw new AliAuthRefreshError("not signed in", "run ais auth login personal --tool=ali");
        return "p";
      },
      metrics,
      alerter,
    };
    await aliSessionOnce(deps);
    await aliSessionOnce(deps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("refresh-failed ali/personal");
    expect(alerts[0]).toContain("fix: run ais auth login personal --tool=ali");
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
