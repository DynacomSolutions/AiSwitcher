import { describe, expect, test } from "bun:test";
import { cdpCommand } from "../../src/identities/auth-session.ts";

/** Fake auth browser: HTTP /json/list advertises a debugger URL pointing at
 * the BROWSER's own bind (a port nothing else listens on), and the WebSocket
 * lives on the same port the client arrived through — exactly the shape a
 * kubectl port-forward produces. Proves cdpCommand rewrites the debugger
 * URL onto the tunnel port instead of dialing it verbatim. */
function startFakeBrowser(): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/list") {
        return Response.json([
          {
            type: "page",
            url: "https://modelstudio.console.alibabacloud.com/",
            // Deliberately wrong host:port — the client must rewrite it.
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/fake",
          },
        ]);
      }
      if (url.pathname === "/devtools/page/fake") {
        if (srv.upgrade(req)) return;
        return new Response("upgrade required", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, data) {
        const message = JSON.parse(String(data)) as { id: number; method: string };
        if (message.method === "Runtime.evaluate") {
          ws.send(JSON.stringify({ id: message.id, result: { result: { value: "https://modelstudio.console.alibabacloud.com/" } } }));
          return;
        }
        if (message.method === "Network.getAllCookies") {
          ws.send(JSON.stringify({ id: message.id, result: { cookies: [{ name: "c", value: "v", domain: ".alibabacloud.com" }] } }));
          return;
        }
        ws.send(JSON.stringify({ id: message.id, error: { message: "unknown method" } }));
      },
    },
  });
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}

describe("cdpCommand through a port-forward", () => {
  test("rewrites the debugger URL onto the tunnel and completes the command", async () => {
    const browser = startFakeBrowser();
    try {
      const result = (await cdpCommand(browser.port, "Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      })) as { result?: { value?: string } };
      expect(result.result?.value).toBe("https://modelstudio.console.alibabacloud.com/");
    } finally {
      browser.stop();
    }
  });

  test("surfaces CDP errors as rejections", async () => {
    const browser = startFakeBrowser();
    try {
      await cdpCommand(browser.port, "NoSuch.method").then(
        () => expect.unreachable(),
        (error: Error) => expect(error.message).toBe("unknown method"),
      );
    } finally {
      browser.stop();
    }
  });
});
