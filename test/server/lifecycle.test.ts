import { describe, expect, test } from "bun:test";
import { get } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ServerLifecycle, stopServerAfterDrain, trackResponseBody } from "../../src/server/lifecycle.ts";
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
      expect(response.complete).toBe(false);

      const responseEnd = new Promise<void>((resolve, reject) => {
        response.on("end", resolve);
        response.on("error", reject);
      });
      const stopPromise = server.stop(false);
      response.resume();
      await responseEnd;
      await lifecycle.waitForDrain();
      expect(lifecycle.inFlight).toBe(0);
      await stopPromise;
      expect(Buffer.concat(received).byteLength).toBe(payload.byteLength);
      expect(response.complete).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test.skipIf(process.platform === "win32")("a real Bun process drains a held response before exiting on SIGTERM", async () => {
    const payloadBytes = 32 * 1024 * 1024;
    const childSource = `
      import { ServerLifecycle, stopServerAfterDrain, trackResponseBody } from "./src/server/lifecycle.ts";
      const lifecycle = new ServerLifecycle();
      const piece = Buffer.alloc(64 * 1024, 0x61);
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          const finish = lifecycle.beginRequest();
          if (!finish) return new Response("draining", { status: 503 });
          let sent = 0;
          const body = new ReadableStream({
            pull(controller) {
              if (sent === ${payloadBytes}) return controller.close();
              controller.enqueue(piece);
              sent += piece.byteLength;
            },
          });
          return trackResponseBody(new Response(body, {
            headers: { "content-length": String(${payloadBytes}) },
          }), finish);
        },
      });
      lifecycle.markReady();
      console.log(JSON.stringify({ port: server.port }));
      process.on("SIGTERM", () => {
        lifecycle.beginDrain();
        console.log("DRAINING");
        void stopServerAfterDrain(server, lifecycle).then(() => { process.exitCode = 0; });
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", childSource], {
      cwd: resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let stdout = "";
    let port = 0;
    let socket: import("node:net").Socket | undefined;
    const responseChunks: Buffer[] = [];
    let responseHeaders = "";
    let responseReady = false;
    let resolveResponse!: (response: { headers: string; body: Buffer }) => void;
    let rejectResponse!: (error: Error) => void;
    const responseFinished = new Promise<{ headers: string; body: Buffer }>((resolveResponseFinished, rejectResponseFinished) => {
      resolveResponse = resolveResponseFinished;
      rejectResponse = rejectResponseFinished;
    });

    const readUntil = async (marker: string) => {
      while (!stdout.includes(marker)) {
        const result = await reader.read();
        if (result.done) throw new Error(`child exited before ${marker}: ${await child.exited}`);
        stdout += new TextDecoder().decode(result.value);
      }
    };

    try {
      await readUntil("\n");
      const startupEnd = stdout.indexOf("\n");
      port = JSON.parse(stdout.slice(0, startupEnd)).port;
      stdout = stdout.slice(startupEnd + 1);
      expect(port).toBeGreaterThan(0);

      const responseReadyPromise = new Promise<void>((resolveReady, rejectReady) => {
        socket = connect(port, "127.0.0.1");
        socket.on("error", rejectReady);
        socket.on("connect", () => socket!.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
        socket.on("data", (chunk) => {
          responseChunks.push(Buffer.from(chunk));
          if (responseReady) return;
          responseHeaders += chunk.toString("latin1");
          const headerEnd = responseHeaders.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const rawHeaders = responseHeaders.slice(0, headerEnd);
          if (!rawHeaders.startsWith("HTTP/1.1 200")) {
            rejectReady(new Error(`unexpected child response headers: ${rawHeaders}`));
            socket!.destroy();
            return;
          }
          responseReady = true;
          socket!.pause();
          resolveReady();
        });
        socket.on("end", () => {
          if (!responseReady) {
            rejectReady(new Error("response connection ended before headers"));
            return;
          }
          const fullResponse = Buffer.concat(responseChunks);
          const headerEnd = fullResponse.indexOf("\r\n\r\n", 0, "ascii");
          resolveResponse({
            headers: fullResponse.toString("latin1", 0, headerEnd),
            body: fullResponse.subarray(headerEnd + 4),
          });
        });
        socket.on("error", rejectResponse);
      });
      await responseReadyPromise;

      child.kill("SIGTERM");
      await readUntil("DRAINING\n");
      const probeResult = await new Promise<string>((resolveProbe, rejectProbe) => {
        const probe = connect(port, "127.0.0.1");
        let probeResponse = "";
        probe.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED") resolveProbe("REFUSED");
          else rejectProbe(error);
        });
        probe.on("connect", () => probe.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
        probe.on("data", (chunk) => {
          probeResponse += chunk.toString("latin1");
          if (probeResponse.includes("\r\n\r\n")) {
            probe.destroy();
            resolveProbe(probeResponse);
          }
        });
      });
      expect(probeResult === "REFUSED" || probeResult.startsWith("HTTP/1.1 503")).toBe(true);
      expect(child.exitCode).toBeNull();
      const heldResponseBytes = responseChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      expect(heldResponseBytes).toBeLessThan(payloadBytes);

      socket!.resume();
      const response = await responseFinished;
      const contentLength = Number(response.headers.match(/\r\ncontent-length:\s*(\d+)/i)?.[1]);
      if (Number.isFinite(contentLength)) {
        expect(response.body.byteLength).toBe(payloadBytes);
        expect(response.body.every((byte) => byte === 0x61)).toBe(true);
      } else {
        expect(/\r\ntransfer-encoding:\s*chunked/i.test(response.headers)).toBe(true);
        expect(decodeChunkedBody(response.body)).toBe(payloadBytes);
      }
      expect(await child.exited).toBe(0);
    } finally {
      reader.releaseLock();
      socket?.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, { timeout: 15_000 });
});

function decodeChunkedBody(body: Buffer): number {
  let offset = 0;
  let decodedBytes = 0;
  while (true) {
    const lineEnd = body.indexOf("\r\n", offset, "ascii");
    if (lineEnd < 0) throw new Error("truncated HTTP chunk header while draining");
    const chunkLength = Number.parseInt(body.toString("ascii", offset, lineEnd).split(";", 1)[0], 16);
    if (!Number.isFinite(chunkLength)) throw new Error("invalid HTTP chunk header while draining");
    offset = lineEnd + 2;
    if (chunkLength === 0) {
      if (body.byteLength < offset + 2) throw new Error("truncated HTTP chunk terminator while draining");
      return decodedBytes;
    }
    if (offset + chunkLength + 2 > body.byteLength) {
      throw new Error(`truncated HTTP response while draining: ${body.byteLength - offset} bytes remain for a ${chunkLength}-byte chunk`);
    }
    for (let index = offset; index < offset + chunkLength; index += 1) {
      if (body[index] !== 0x61) throw new Error(`unexpected response byte at decoded offset ${decodedBytes + index - offset}`);
    }
    decodedBytes += chunkLength;
    offset += chunkLength + 2;
  }
}
