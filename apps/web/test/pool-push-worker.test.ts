import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const script = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();

function worker(hasClient = true) {
  const origin = "https://console.example";
  const target = "/limits/pools/codex/sample-pool?reset=1";
  const calls: unknown[][] = [];
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const client = {
    url: origin + "/limits",
    async navigate(url: string) { calls.push(["navigate", url]); return client; },
    async focus() { calls.push(["focus"]); },
  };
  runInNewContext(script, { URL, fetch: () => { throw new Error("A click must not call an API"); }, self: {
    location: { origin },
    registration: { async showNotification(...args: unknown[]) { calls.push(args); } },
    clients: {
      async matchAll() { return hasClient ? [client] : []; },
      async openWindow(url: string) { calls.push(["openWindow", url]); },
    },
    addEventListener(name: string, listener: (event: Record<string, unknown>) => void) { listeners.set(name, listener); },
  } });
  const event = async (name: string, body: Record<string, unknown>) => {
    let task: Promise<unknown> | undefined;
    listeners.get(name)?.({ ...body, waitUntil: (promise: Promise<unknown>) => { task = promise; } });
    await task;
  };
  return { origin, target, calls,
    push: (poolAlert?: string) => event("push", { data: { json: () => ({ title: "Sample", tag: "stable", url: target, poolAlert }) } }),
    click: (action: string, url = target) => event("notificationclick", {
      action,
      notification: { close: () => calls.push(["close"]), data: { url } },
    }),
  };
}

test("adds review and dismiss actions only when the alert offers a reset", async () => {
  const { push, calls } = worker();
  await push("review");
  await push("dismiss");
  await push();
  expect(calls[0][1]).toMatchObject({ tag: "stable", actions: [
    { action: "review-reset", title: "Use reset" }, { action: "dismiss", title: "Dismiss" },
  ] });
  expect(calls[1][1]).toMatchObject({ actions: [{ action: "dismiss", title: "Dismiss" }] });
  expect(calls[2][1]).not.toHaveProperty("actions");
});

test("Dismiss closes without navigation and either review tap opens the same URL", async () => {
  const { click, calls, origin, target } = worker();
  await click("dismiss");
  expect(calls.splice(0)).toEqual([["close"]]);
  await click("review-reset");
  const expected = [["close"], ["navigate", origin + target], ["focus"]];
  expect(calls.splice(0)).toEqual(expected);
  await click("");
  expect(calls).toEqual(expected);
});

test("one body tap opens the review when the Home Screen app has no window", async () => {
  const { click, calls, origin, target } = worker(false);
  await click("");
  expect(calls).toEqual([["close"], ["openWindow", origin + target]]);
});
