import { describe, expect, test, afterEach } from "bun:test";
import { getAuthBrowserNamespace } from "../../src/identities/auth-browser.ts";

describe("getAuthBrowserNamespace", () => {
  const originalEnv = process.env.AIS_AUTH_BROWSER_NAMESPACE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AIS_AUTH_BROWSER_NAMESPACE;
    } else {
      process.env.AIS_AUTH_BROWSER_NAMESPACE = originalEnv;
    }
  });

  test("returns default namespace when env var is unset", () => {
    delete process.env.AIS_AUTH_BROWSER_NAMESPACE;
    expect(getAuthBrowserNamespace()).toBe("chrome-mcp");
  });

  test("returns default namespace when env var is empty", () => {
    process.env.AIS_AUTH_BROWSER_NAMESPACE = "";
    expect(getAuthBrowserNamespace()).toBe("chrome-mcp");
  });

  test("returns default namespace when env var is only whitespace", () => {
    process.env.AIS_AUTH_BROWSER_NAMESPACE = "   ";
    expect(getAuthBrowserNamespace()).toBe("chrome-mcp");
  });

  test("returns overridden namespace from env var", () => {
    process.env.AIS_AUTH_BROWSER_NAMESPACE = "auth-browser-ns";
    expect(getAuthBrowserNamespace()).toBe("auth-browser-ns");
  });

  test("trims whitespace from env var", () => {
    process.env.AIS_AUTH_BROWSER_NAMESPACE = "  custom-namespace  ";
    expect(getAuthBrowserNamespace()).toBe("custom-namespace");
  });
});
