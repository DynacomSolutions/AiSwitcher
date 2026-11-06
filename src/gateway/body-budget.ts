/**
 * Limits the request-body bytes the gateway holds for replay at one time. A request reserves its declared body size
 * before the body is read and gives it back once the upstream has answered. Requests that do not fit wait (holding
 * no memory: the socket backpressures the client) until earlier ones finish or the client goes away, never failing, so the buffered bodies never exceed the
 * budget no matter how many sessions send at once. A single request larger than the whole budget is let through
 * alone.
 */
export class BodyBudget {
  private used = 0;
  private readonly waiters: Array<{ bytes: number; grant: () => void }> = [];

  constructor(
    readonly limit: number,
    private readonly onWaiting?: (n: number) => void,
  ) {}

  get inUse(): number {
    return this.used;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves with a release function (idempotent). Rejects when `signal` aborts while waiting. */
  async reserve(bytes: number, signal?: AbortSignal): Promise<() => void> {
    const want = Math.min(Math.max(0, bytes), this.limit);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (this.waiters.length === 0 && this.used + want <= this.limit) return this.take(want);
    await new Promise<void>((resolve, reject) => {
      const w = {
        bytes: want,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        this.onWaiting?.(this.waiters.length);
        reject(new DOMException("aborted", "AbortError"));
        this.pump();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
      this.onWaiting?.(this.waiters.length);
    });
    return this.release(want);
  }

  private take(want: number): () => void {
    this.used += want;
    return this.release(want);
  }

  private release(want: number): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.used -= want;
      this.pump();
    };
  }

  /** Grants waiters in arrival order while they fit. The granted bytes are counted here, before the waiter resumes. */
  private pump(): void {
    for (;;) {
      const w = this.waiters[0];
      if (!w || this.used + w.bytes > this.limit) return;
      this.waiters.shift();
      this.used += w.bytes;
      this.onWaiting?.(this.waiters.length);
      w.grant();
    }
  }
}
