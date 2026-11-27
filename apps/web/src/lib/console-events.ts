import { consoleHeaders } from "./api";

const MAX_FRAME_LENGTH = 8_192;
const RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

interface EventFrame {
  event: string;
  data: string;
}

/** Parse complete SSE frames across arbitrary UTF-8 and line ending boundaries. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (frame: EventFrame) => boolean | void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let skipLF = false;
  let frameSize = 0;
  let event = "";
  let data: string[] = [];

  function endLine(): boolean | void {
    if (line === "") {
      const ended = data.length > 0 && onEvent({ event, data: data.join("\n") });
      event = "";
      data = [];
      frameSize = 0;
      return ended;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    line = "";
  }

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      for (const character of decoder.decode(chunk.value, { stream: true })) {
        if (skipLF && character === "\n") {
          skipLF = false;
          continue;
        }
        skipLF = character === "\r";
        if (++frameSize > MAX_FRAME_LENGTH) throw new Error("Console event is too large");
        if (character === "\n" || character === "\r") {
          if (endLine()) return;
        } else {
          line += character;
        }
      }
    }
  } finally {
    // A bad frame can end the connection while the HTTP response is still open.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

interface ConsoleEventHandlers {
  onReady: (reconnected: boolean) => void;
  onDisconnect: () => void;
  onChange: (topics: string[]) => void;
}

interface ConnectionOptions {
  fetch?: typeof fetch;
  retryMs?: number;
  maxRetryMs?: number;
  heartbeatTimeoutMs?: number;
  wait?: typeof waitForRetry;
}

/** Use fetch so the stream can send the Console authentication header. */
export async function listenToConsoleEvents(
  handlers: ConsoleEventHandlers,
  signal: AbortSignal,
  options: ConnectionOptions = {},
): Promise<void> {
  const initialDelay = options.retryMs ?? RETRY_MS;
  const maxDelay = options.maxRetryMs ?? MAX_RETRY_MS;
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  let retryDelay = initialDelay;
  let reconnecting = false;

  // React's development remount cancels the first subscription before it needs a socket.
  await Promise.resolve();
  while (!signal.aborted) {
    const connection = new AbortController();
    const abortConnection = () => connection.abort();
    signal.addEventListener("abort", abortConnection, { once: true });
    const startDeadline = () => setTimeout(abortConnection, heartbeatTimeout);
    let timeout = startDeadline();
    const refreshDeadline = () => {
      clearTimeout(timeout);
      timeout = startDeadline();
    };
    let ready = false;
    let rollover = false;
    try {
      const headers = consoleHeaders();
      headers.set("Accept", "text/event-stream");
      const response = await (options.fetch ?? fetch)("/api/events", {
        headers,
        cache: "no-store",
        redirect: "error",
        signal: connection.signal,
      });
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!response.ok || contentType !== "text/event-stream" || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Console event stream unavailable");
      }
      await readEvents(response.body, ({ event, data }) => {
        if (signal.aborted || connection.signal.aborted) return;
        if (event === "ready" && !ready) {
          ready = true;
          refreshDeadline();
          handlers.onReady(reconnecting);
        } else if (ready && event === "heartbeat") {
          refreshDeadline();
          retryDelay = initialDelay;
        } else if (ready && event === "rollover") {
          rollover = true;
          retryDelay = initialDelay;
          return true;
        } else if (ready && event === "change") {
          const topics: unknown = JSON.parse(data);
          if (Array.isArray(topics) && topics.every((topic) => typeof topic === "string")) {
            refreshDeadline();
            handlers.onChange(topics);
          }
        }
      });
    } catch {
      // Network errors, HTTP errors and malformed frames use the same retry path.
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortConnection);
      abortConnection();
    }
    if (signal.aborted) return;
    reconnecting = true;
    if (rollover) continue;
    handlers.onDisconnect();
    await (options.wait ?? waitForRetry)(retryDelay, signal);
    retryDelay = Math.min(maxDelay, retryDelay * 2);
  }
}
