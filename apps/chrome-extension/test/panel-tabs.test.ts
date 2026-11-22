import { describe, expect, test } from "bun:test";
import { defaultTab, nextTab } from "../src/sidepanel/tabs.ts";

describe("panel tabs", () => {
  test("defaultTab is chat when signed in and status when signed out", () => {
    expect(defaultTab({ signedIn: true, status: "connected" })).toBe("chat");
    expect(defaultTab({ signedIn: true, status: "disconnected" })).toBe("chat");
    expect(defaultTab({ signedIn: false, status: "signed_out" })).toBe("status");
    expect(defaultTab({ signedIn: true, status: "signed_out" })).toBe("status");
  });
  test("nextTab wraps with the arrow keys and Home and End", () => {
    expect(nextTab("chat", "ArrowRight")).toBe("status");
    expect(nextTab("status", "ArrowRight")).toBe("chat");
    expect(nextTab("chat", "ArrowLeft")).toBe("status");
    expect(nextTab("status", "ArrowLeft")).toBe("chat");
    expect(nextTab("status", "Home")).toBe("chat");
    expect(nextTab("chat", "End")).toBe("status");
  });
  test("viewFor and updateView still export from sidepanel.ts", async () => {
    const m = await import("../src/sidepanel/sidepanel.ts");
    expect(typeof m.viewFor).toBe("function");
    expect(typeof m.updateView).toBe("function");
  });
});
