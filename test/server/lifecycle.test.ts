import { describe, expect, test } from "bun:test";
import { get } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ServerLifecycle, trackResponseBody } from "../../src/server/lifecycle.ts";
import { validateWarmHtml } from "../../src/server/serve.ts";

describe("validateWarmHtml", () => {
  test("accepts the repository SPA shell and its existing script asset", () => {
    const webRoot = join(resolve(import.meta.dir, "../.."), "apps/web");
    const html = readFileSync(join(webRoot, "index.html"), "utf8");
    expect(() => validateWarmHtml(html, "text/html; charset=utf-8", webRoot)).not.toThrow();
  });

  test("rejects a wrong content type or a non-document response", () => {
    expect(() => validateWarmHtml("<!doctype html><html></html>", "application/json", ".")).toThrow("content type");
    expect(() => validateWarmHtml("not html", "text/html", ".")).toThrow("HTML document");
  });

  test("rejects missing local script and stylesheet assets", () => {
    const root = resolve(import.meta.dir, "../..");
    const html = '<!doctype html><html><head><link rel="stylesheet" href="missing.css"></head><body><script type="module" src="missing.js"></script></body></html>';
    expect(() => validateWarmHtml(html, "text/html", root)).toThrow("missing asset");
  });
});

describe("ServerLifecycle", () => {
  test("becomes ready after warming and becomes unready when draining", () => {
    const lifecycle = new ServerLifecycle();
    expect(lifecycle.isReady).toBe(false);
    lifecycle.markReady();
    expect(lifecycle.isReady).toBe(true);
    lifecycle.beginDrain();
    expect(lifecycle.isReady).toBe(false);
    expect(lifecycle.isDraining).toBe(true);
  });

  test("rejects new requests while draining and tracks existing requests until finished", () => {
    const lifecycle = new ServerLifecycle();
    const finish = lifecycle.beginRequest();
    expect(finish).toBeDefined();
    expect(lifecycle.inFlight).toBe(1);

    lifecycle.beginDrain();
    expect(lifecycle.beginRequest()).toBeUndefined();
    expect(lifecycle.inFlight).toBe(1);

    finish?.();
    finish?.();
    expect(lifecycle.inFlight).toBe(0);
  });

  test("resolves drain only after draining begins and all response bodies finish", async () => {
    const lifecycle = new ServerLifecycle();
    let drained = false;
    const drain = lifecycle.waitForDrain().then(() => { drained = true; });
    const finish = lifecycle.beginRequest()!;
    lifecycle.beginDrain();
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await drain;
    expect(drained).toBe(true);
  });

  test("keeps a streamed response in flight through drain until its body closes", async () => {
    const lifecycle = new ServerLifecycle();
    const finish = lifecycle.beginRequest();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await held;
        controller.enqueue(new TextEncoder().encode("done"));
        controller.close();
      },
    });
    const response = trackResponseBody(new Response(source, {
      status: 201,
      statusText: "Created",
      headers: { "x-stream": "yes" },
    }), finish!);

    lifecycle.beginDrain();
    expect(lifecycle.inFlight).toBe(1);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-stream")).toBe("yes");

    release();
    expect(await response.text()).toBe("done");
    expect(lifecycle.inFlight).toBe(0);
  });

  test("finishes tracked requests when a streamed body is cancelled or errors", async () => {
    const cancelled = new ServerLifecycle();
    const finishCancelled = cancelled.beginRequest()!;
    let cancelCalled = false;
    const cancelResponse = trackResponseBody(new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelCalled = true; },
    })), finishCancelled);
    const cancelReader = cancelResponse.body!.getReader();
    await cancelReader.cancel();
    expect(cancelCalled).toBe(true);
    expect(cancelled.inFlight).toBe(0);

    const errored = new ServerLifecycle();
    const finishErrored = errored.beginRequest()!;
    const errorResponse = trackResponseBody(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("stream failed")); },
    })), finishErrored);
    await expect(errorResponse.text()).rejects.toThrow("stream failed");
    expect(errored.inFlight).toBe(0);
  });

  test("a slow HTTP reader can still receive bytes after the body and pending request finish", async () => {
    const lifecycle = new ServerLifecycle();
    const payload = Buffer.alloc(32 * 1024 * 1024, 0x61);
    let sourceEnded!: () => void;
    const sourceDone = new Promise<void>((resolve) => { sourceEnded = resolve; });
    const server = Bun.serve({
      port: 0,
      fetch() {
        const finish = lifecycle.beginRequest()!;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(payload);
            controller.close();
            sourceEnded();
          },
        });
        return trackResponseBody(new Response(body, {
          headers: { "content-length": String(payload.byteLength) },
        }), finish);
      },
    });

    try {
      const received: Buffer[] = [];
      let response!: import("node:http").IncomingMessage;
      const responseReady = new Promise<void>((resolve, reject) => {
        const request = get(server.url, (incoming) => {
          response = incoming;
          incoming.pause();
          incoming.on("data", (chunk: Buffer) => received.push(chunk));
          incoming.on("error", reject);
          resolve();
        });
        request.on("error", reject);
      });
      await responseReady;
      lifecycle.beginDrain();
      await sourceDone;
      if (Bun.version === "1.4.4") expect(lifecycle.inFlight).toBeGreaterThan(0);

      const responseEnd = new Promise<void>((resolve, reject) => {
        response.on("end", resolve);
        response.on("error", reject);
      });
      response.resume();
      await responseEnd;
      await lifecycle.waitForDrain();
      expect(lifecycle.inFlight).toBe(0);

      const stopPromise = server.stop(false);
      await stopPromise;
      expect(Buffer.concat(received).byteLength).toBe(payload.byteLength);
      expect(response.complete).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
