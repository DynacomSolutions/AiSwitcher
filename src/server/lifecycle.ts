/** Readiness and request-drain state for the console HTTP server. */
export class ServerLifecycle {
  private state: "warming" | "ready" | "draining" = "warming";
  private activeRequests = 0;
  private resolveDrained!: () => void;
  private readonly drained = new Promise<void>((resolve) => { this.resolveDrained = resolve; });
  private drainResolved = false;

  get isReady(): boolean {
    return this.state === "ready";
  }

  get isDraining(): boolean {
    return this.state === "draining";
  }

  get inFlight(): number {
    return this.activeRequests;
  }

  markReady(): void {
    if (this.state === "warming") this.state = "ready";
  }

  beginRequest(): (() => void) | undefined {
    if (this.state === "draining") return undefined;
    this.activeRequests += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeRequests -= 1;
      this.resolveDrainIfComplete();
    };
  }

  beginDrain(): void {
    this.state = "draining";
    this.resolveDrainIfComplete();
  }

  /** Resolves once draining has begun and every tracked response body ended. */
  waitForDrain(): Promise<void> {
    return this.drained;
  }

  private resolveDrainIfComplete(): void {
    if (this.state !== "draining" || this.activeRequests !== 0 || this.drainResolved) return;
    this.drainResolved = true;
    this.resolveDrained();
  }
}

/** Stop accepting requests and wait for both Bun's connection drain and the
 * application-level response-body tracking to finish. */
export function stopServerAfterDrain(
  server: { stop(closeActiveConnections?: boolean): Promise<void> },
  lifecycle: ServerLifecycle,
): Promise<void> {
  return Promise.all([server.stop(false), lifecycle.waitForDrain()]).then(() => undefined);
}

/** Keep a request in flight until its response body has been consumed or
 * abandoned. Bun's fetch promise resolves as soon as headers are available. */
export function trackResponseBody(response: Response, finish: () => void): Response {
  const body = response.body;
  if (!body) {
    finish();
    return response;
  }

  const reader = body.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    finish();
  };
  const trackedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle();
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(trackedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
