import { loadSyncConfig } from "../sync/config.ts";
import { handleHostRequest } from "./adapter.ts";
import { encodeJsonFrame, readJsonFrame, readExact, assertEnd, MAX_HOST_PAYLOAD_BYTES, type HostOperation, type HostResponse } from "./protocol.ts";

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const REMOTE_TIMEOUT_MS = 30_000;
export type HostSource = { kind: "local" } | { kind: "ssh"; alias: string };
export interface HostCall { operation: HostOperation; payload?: Uint8Array; preview?: unknown; signal?: AbortSignal; }
export interface HostResult { header: HostResponse; payload: Uint8Array; }
type SpawnHost = (argv: string[], options: { stdin: "pipe"; stdout: "pipe"; stderr: "ignore"; signal?: AbortSignal }) => { stdin: { write(bytes: Uint8Array): number | Promise<number>; end(): void }; stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };

function requestHeader(call: HostCall): Uint8Array {
  if (!["capabilities", "exportSnapshot", "importLogs", "previewConfig"].includes(call.operation)) throw new Error("invalid host operation");
  if ((call.payload?.byteLength ?? 0) > MAX_HOST_PAYLOAD_BYTES) throw new Error("host request payload exceeds the protocol limit");
  if (call.operation !== "importLogs" && call.payload?.byteLength) throw new Error("unexpected host request payload");
  if (call.operation !== "previewConfig" && call.preview !== undefined) throw new Error("unexpected host preview data");
  return encodeJsonFrame({ version: 1, operation: call.operation, payloadBytes: call.payload?.byteLength ?? 0, ...(call.preview === undefined ? {} : { preview: call.preview }) });
}

async function readResult(stream: ReadableStream<Uint8Array>): Promise<HostResult> {
  const reader = stream.getReader();
  try {
    const value = await readJsonFrame(reader);
    if (!value || typeof value !== "object") throw new Error("invalid host response");
    const header = value as HostResponse;
    if (Object.keys(value as object).some((key) => !["version", "ok", "payloadBytes", "error", "result"].includes(key))) throw new Error("unknown host response field");
    if (header.version !== 1 || typeof header.ok !== "boolean" || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0 || header.payloadBytes > MAX_HOST_PAYLOAD_BYTES || (header.ok && header.error !== undefined) || (!header.ok && (header.payloadBytes !== 0 || typeof header.error !== "string"))) throw new Error("invalid host response fields");
    const payload = header.payloadBytes ? await readExact(reader, header.payloadBytes) : new Uint8Array();
    await assertEnd(reader);
    return { header, payload };
  } finally { reader.releaseLock(); }
}

export async function requestHost(source: HostSource, call: HostCall, spawn: SpawnHost = (argv, options) => Bun.spawn(argv, options), timeoutMs = REMOTE_TIMEOUT_MS): Promise<HostResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid host request timeout");
  if (call.signal?.aborted) throw new Error("host request cancelled");
  const encodedRequest = requestHeader(call);
  if (source.kind === "local") {
    if (call.signal?.aborted) throw new Error("host request cancelled");
    const request = { version: 1 as const, operation: call.operation, payloadBytes: call.payload?.byteLength ?? 0, ...(call.preview === undefined ? {} : { preview: call.preview }) };
    const result = await handleHostRequest(request, call.payload ?? new Uint8Array(), undefined, call.signal);
    const response = await readResult(new ReadableStream({ start(controller) { controller.enqueue(result.header); if (result.payload.byteLength) controller.enqueue(result.payload); controller.close(); } }));
    return response;
  }
  if (!HOST_PATTERN.test(source.alias)) throw new Error("invalid SSH host alias");
  const config = await loadSyncConfig();
  if (!config.remotes.includes(source.alias)) throw new Error("SSH host is not configured in ais sync remotes");
  const ssh = Bun.which("ssh") ?? "ssh";
  const proc = spawn([ssh, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", source.alias, "ais", "host", "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", ...(call.signal ? { signal: call.signal } : {}) });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* completed */ } }, timeoutMs);
  try {
    await proc.stdin.write(encodedRequest);
    if (call.payload?.byteLength) await proc.stdin.write(call.payload);
    proc.stdin.end();
    const resultPromise = readResult(proc.stdout).catch(() => { throw new Error("remote ais host is missing, incompatible, or returned a malformed response; update ais on that host"); });
    const [result, code] = await Promise.all([resultPromise, proc.exited]);
    if (code !== 0) throw new Error("remote ais host request failed");
    if (!result.header.ok) throw new Error("remote ais host request failed");
    return result;
  } catch (error) {
    try { proc.kill(); } catch { /* completed */ }
    if (timedOut) throw new Error("remote ais host request timed out");
    throw error;
  } finally { clearTimeout(timer); }
}
