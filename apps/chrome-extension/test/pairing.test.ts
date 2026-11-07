import { describe, expect, test } from "bun:test";
import { authorizeUrl, autoProfileLabel, KEYS, parseConsoleUrl, platformName, signIn, UNREACHABLE_MESSAGE, validateGatewayUrl } from "../src/background/pairing.ts";
import { FakeChrome } from "./fakes.ts";

const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb";

describe("urls", () => {
  test("gateway url requires wss except localhost", () => {
    expect(validateGatewayUrl("wss://gw.example.test/gateway/")).toBe("wss://gw.example.test/gateway");
    expect(validateGatewayUrl("ws://localhost:8080")).toBe("ws://localhost:8080");
    expect(() => validateGatewayUrl("ws://gw.example.test")).toThrow();
    expect(() => validateGatewayUrl("https://gw.example.test")).toThrow();
  });
  test("console url needs https (http only on localhost) and drops query and trailing slash", () => {
    expect(parseConsoleUrl(" https://ais.example.com/ ")).toBe("https://ais.example.com");
    expect(parseConsoleUrl("https://ais.example.com/base/?x=1#y")).toBe("https://ais.example.com/base");
    expect(parseConsoleUrl("http://127.0.0.1:47129")).toBe("http://127.0.0.1:47129");
    for (const bad of ["", "ais.example.com", "http://ais.example.com", "ftp://x.example.com", "https://u:p@ais.example.com"]) expect(parseConsoleUrl(bad)).toBeUndefined();
  });
  test("authorize url keeps a base path", () => {
    const u = new URL(authorizeUrl("https://ais.example.com/base", REDIRECT, "st", "me@example.com"));
    expect(u.pathname).toBe("/base/browser/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("label")).toBe("me@example.com");
  });
});

describe("profile label", () => {
  test("uses the Chrome account email", async () => {
    expect(await autoProfileLabel(new FakeChrome().storage, async () => "me@example.com", "MacIntel")).toBe("me@example.com");
  });
  test("falls back to a stable generated name", async () => {
    const c = new FakeChrome();
    const a = await autoProfileLabel(c.storage, async () => undefined, "MacIntel");
    expect(a).toMatch(/^Chrome on macOS [0-9a-f]{6}$/);
    expect(await autoProfileLabel(c.storage, async () => "", "MacIntel")).toBe(a);
  });
  test("platform names", () => {
    expect(platformName("Win32")).toBe("Windows");
    expect(platformName("Linux x86_64")).toBe("Linux");
    expect(platformName("")).toBe("computer");
  });
});

describe("sign in", () => {
  const deps = (chrome: FakeChrome, launch: (url: string) => Promise<string | undefined>) => ({ storage: chrome.storage, launch, redirectUri: REDIRECT, getEmail: async () => "me@example.com", platform: "Linux", newState: () => "st4te" });

  test("stores token, gateway and console URL from the redirect", async () => {
    const chrome = new FakeChrome();
    let opened = "";
    const r = await signIn(deps(chrome, async url => { opened = url; return `${REDIRECT}#token=tok&binding=work&state=st4te&gateway=${encodeURIComponent("wss://ais.example.com/gateway")}&target_kind=pool&target_name=pool-one`; }), "https://ais.example.com/");
    expect(opened).toStartWith("https://ais.example.com/browser/authorize?");
    expect(opened).toContain("state=st4te");
    expect(r.binding).toBe("work");
    expect(chrome.store[KEYS.token]).toBe("tok");
    expect(chrome.store[KEYS.gatewayUrl]).toBe("wss://ais.example.com/gateway");
    expect(chrome.store[KEYS.consoleUrl]).toBe("https://ais.example.com");
    expect(chrome.store[KEYS.target]).toEqual({ kind: "pool", pool: "pool-one" });
    expect(chrome.store[KEYS.profileLabel]).toBe("me@example.com");
  });
  test("a state mismatch stores nothing", async () => {
    const chrome = new FakeChrome();
    await expect(signIn(deps(chrome, async () => `${REDIRECT}#token=tok&binding=b&state=other&gateway=wss%3A%2F%2Fg.example.com`), "https://ais.example.com")).rejects.toThrow(/did not match/);
    expect(chrome.store[KEYS.token]).toBeUndefined();
  });
  test("cancel and refusal store nothing", async () => {
    const chrome = new FakeChrome();
    await expect(signIn(deps(chrome, async () => `${REDIRECT}#error=cancelled&state=st4te`), "https://ais.example.com")).rejects.toThrow(/cancelled/);
    await expect(signIn(deps(chrome, async () => { throw new Error("The user did not approve access."); }), "https://ais.example.com")).rejects.toThrow(/cancelled/);
    expect(chrome.store[KEYS.token]).toBeUndefined();
  });
  test("a page that cannot load reads as unreachable", async () => {
    const chrome = new FakeChrome();
    await expect(signIn(deps(chrome, async () => { throw new Error("Authorization page could not be loaded."); }), "https://ais.example.com")).rejects.toThrow(UNREACHABLE_MESSAGE);
  });
  test("a non-wss gateway from the redirect is refused", async () => {
    const chrome = new FakeChrome();
    await expect(signIn(deps(chrome, async () => `${REDIRECT}#token=t&binding=b&state=st4te&gateway=${encodeURIComponent("ws://evil.example.com")}`), "https://ais.example.com")).rejects.toThrow(/wss/);
    expect(chrome.store[KEYS.token]).toBeUndefined();
  });
  test("an invalid address is refused before anything opens", async () => {
    let opened = false;
    await expect(signIn(deps(new FakeChrome(), async () => { opened = true; return undefined; }), "nonsense")).rejects.toThrow(/https/);
    expect(opened).toBe(false);
  });
});
