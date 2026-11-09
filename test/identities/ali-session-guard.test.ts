import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanLoginInProgress, isAliLoginUrl, standDownToGateway, withAliBrowserLock } from "../../src/identities/auth-session.ts";
import { heartbeatHolds, writeHeartbeat } from "../../src/identities/gateway-heartbeat.ts";
import { isGatewayManagedHere } from "../../src/identities/gateway-managed.ts";

describe("a person's sign-in is never interrupted", () => {
  test("sign-in pages are recognised, the console is not", () => {
    expect(isAliLoginUrl("https://account.alibabacloud.com/login/login.htm?x=1")).toBe(true);
    expect(isAliLoginUrl("https://passport.alibabacloud.com/ac/iv")).toBe(true);
    expect(isAliLoginUrl("https://signin.alibabacloud.com/")).toBe(true);
    expect(isAliLoginUrl("https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription")).toBe(false);
    expect(isAliLoginUrl("https://example.com/login")).toBe(false);
    expect(isAliLoginUrl("about:blank")).toBe(false);
  });

  test("on a sign-in page it is a person's unless AIS put the tab there itself", () => {
    const login = "https://account.alibabacloud.com/login/login.htm";
    expect(humanLoginInProgress(login, undefined)).toBe(true);
    expect(humanLoginInProgress(login, false)).toBe(true);
    expect(humanLoginInProgress(login, true)).toBe(false);
    expect(humanLoginInProgress("https://modelstudio.console.alibabacloud.com/", false)).toBe(false);
    expect(humanLoginInProgress(undefined, false)).toBe(false);
  });
});

describe("the shared browser lock", () => {
  test("two renewals take turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ali-lock-"));
    const lock = join(dir, "browser.lock");
    const order: string[] = [];
    const run = (name: string) =>
      withAliBrowserLock(async () => {
        order.push(`${name}:in`);
        await Bun.sleep(80);
        order.push(`${name}:out`);
      }, lock);
    await Promise.all([run("a"), run("b")]);
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });
});

describe("the lock on an abandoned renewal", () => {
  test("is freed at once when the renewal is aborted, even though it never finishes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ali-lock-"));
    const lock = join(dir, "browser.lock");
    const ctrl = new AbortController();
    const stuck = withAliBrowserLock(() => new Promise<string>(() => {}), lock, ctrl.signal);
    stuck.catch(() => undefined);
    await Bun.sleep(30);
    ctrl.abort();
    await expect(stuck).rejects.toThrow();
    const t0 = Date.now();
    expect(await withAliBrowserLock(async () => "next", lock)).toBe("next");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("the host stands down while the gateway owns ali", () => {
  test("stand-down only skips the run: the host timer is left installed", async () => {
    expect(await standDownToGateway("personal", { managed: async () => true })).toBe(true);
    expect(await standDownToGateway("personal", { managed: async () => false })).toBe(false);
  });

  test("a fresh heartbeat naming ali/<id> makes it gateway-managed; a stale or missing one hands it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ali-hb-"));
    const hbPath = join(dir, "hb.json");
    const reg = join(dir, "identities.json");
    await writeFile(reg, JSON.stringify({ version: 1, identities: [{ name: "personal", label: "p", configDir: dir }, { name: "old", label: "o", configDir: dir, retired: true }] }));
    const prev = process.env.AIS_GATEWAY_HEARTBEAT;
    const prevOwner = process.env.AIS_GATEWAY_OWNER;
    process.env.AIS_GATEWAY_HEARTBEAT = hbPath;
    process.env.AIS_GATEWAY_OWNER = "0";
    try {
      expect(await isGatewayManagedHere("ali", "personal", reg)).toBe(false); // no heartbeat
      await writeHeartbeat({ version: 1, passAt: new Date().toISOString(), held: { "ali/personal": {}, "ali/old": {} } }, hbPath);
      expect(await heartbeatHolds("ali", "personal")).toBe(true);
      expect(await isGatewayManagedHere("ali", "personal", reg)).toBe(true);
      expect(await isGatewayManagedHere("ali", "old", reg)).toBe(false); // retired
      expect(await isGatewayManagedHere("ali", "other", reg)).toBe(false); // not named
      await writeHeartbeat({ version: 1, passAt: new Date(Date.now() - 3_600_000).toISOString(), held: { "ali/personal": {} } }, hbPath);
      expect(await isGatewayManagedHere("ali", "personal", reg)).toBe(false); // stale
      await writeHeartbeat({ version: 1, passAt: new Date().toISOString(), held: { "ali/personal": {} } }, hbPath);
      process.env.AIS_GATEWAY_OWNER = "1";
      expect(await isGatewayManagedHere("ali", "personal", reg)).toBe(false); // the gateway itself never stands down
    } finally {
      if (prev === undefined) delete process.env.AIS_GATEWAY_HEARTBEAT;
      else process.env.AIS_GATEWAY_HEARTBEAT = prev;
      if (prevOwner === undefined) delete process.env.AIS_GATEWAY_OWNER;
      else process.env.AIS_GATEWAY_OWNER = prevOwner;
    }
  });
});
