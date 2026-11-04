import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { BROWSER_TOOLS } from "../../src/browser/protocol.ts";
import { handleRpc, STOPPED_BY_USER_NOTE, type ShimContext } from "../../src/browser/mcp-shim.ts";

let seen: { auth: string | null; body: any }[] = [];
let reply: unknown = {};
const app = new Hono();
app.post("/browser/call", async (c) => {
  seen.push({ auth: c.req.header("authorization") ?? null, body: await c.req.json() });
  return c.json(reply as object);
});
const ctx = (url = "http://gw.test/"): ShimContext => ({
  gatewayUrl: async () => url,
  token: async () => "tok",
  session: { id: "abcdef123", identity: "work", label: "work / abcdef" },
  fetch: ((u: string, init: RequestInit) => app.request(u, init)) as unknown as typeof fetch,
});
afterEach(() => { seen = []; });

const call = (name: string, args: object = {}) => handleRpc({ id: 1, method: "tools/call", params: { name, arguments: args } }, ctx()) as Promise<any>;

test("initialize and notification", async () => {
  const r: any = await handleRpc({ id: 1, method: "initialize" }, ctx());
  expect(r.result.serverInfo.name).toBe("ais-browser");
  expect(await handleRpc({ method: "notifications/initialized" }, ctx())).toBeUndefined();
});

test("tools/list returns every tool; browser prop on all but list_browsers", async () => {
  const r: any = await handleRpc({ id: 2, method: "tools/list" }, ctx());
  expect(r.result.tools.map((t: any) => t.name)).toEqual([...BROWSER_TOOLS]);
  for (const t of r.result.tools) {
    expect(t.inputSchema.properties.browser !== undefined).toBe(t.name !== "list_browsers");
  }
});

test("tools/call posts to the gateway and maps image content", async () => {
  reply = { id: "x", ok: true, content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/jpeg", data: "QQ==" }] };
  const r = await call("screenshot", { tabId: 3, browser: "b1" });
  expect(r.result.content).toEqual([{ type: "text", text: "hi" }, { type: "image", data: "QQ==", mimeType: "image/jpeg" }]);
  expect(r.result.isError).toBeUndefined();
  expect(seen[0]).toEqual({ auth: "Bearer tok", body: { browser: "b1", session: { id: "abcdef123", identity: "work", label: "work / abcdef" }, tool: "screenshot", args: { tabId: 3 } } });
});

test("error codes become isError text; stopped_by_user adds the sentence", async () => {
  reply = { id: "x", ok: false, error: "no_browser", message: "none" };
  expect((await call("tabs_context")).result).toEqual({ isError: true, content: [{ type: "text", text: "no_browser: none" }] });
  reply = { id: "x", ok: false, error: "stopped_by_user", message: "stopped" };
  expect((await call("tabs_context")).result.content[0].text).toBe(`stopped_by_user: stopped ${STOPPED_BY_USER_NOTE}`);
});

test("HTTP failure and missing token are tool errors", async () => {
  const r: any = await handleRpc({ id: 1, method: "tools/call", params: { name: "tabs_context" } }, { ...ctx(), token: async () => undefined });
  expect(r.result.isError).toBe(true);
  expect(seen).toEqual([]);
});
