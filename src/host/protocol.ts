/** Private host transport framing. Every frame is a bounded UTF-8 JSON value,
 * preceded by a four-byte unsigned big-endian length. Binary bodies follow the
 * JSON header and are covered by that header's payloadBytes field. */
export const HOST_PROTOCOL_VERSION = 1 as const;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_HOST_PAYLOAD_BYTES = 64 * 1024 * 1024;

export type HostOperation = "capabilities" | "exportSnapshot" | "importLogs" | "previewConfig";
export interface HostRequest { version: 1; operation: HostOperation; payloadBytes: number; preview?: unknown; }
export interface HostResponse { version: 1; ok: boolean; payloadBytes: number; error?: string; result?: unknown; }

export function encodeJsonFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > MAX_HEADER_BYTES) throw new Error("host protocol header exceeds the size limit");
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

type ByteReader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };
const pending = new WeakMap<object, Uint8Array>();

export async function readExact(reader: ByteReader, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HOST_PAYLOAD_BYTES) throw new Error("host protocol frame length is out of range");
  const output = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    let chunk = pending.get(reader);
    if (!chunk?.byteLength) {
      const next = await reader.read();
      if (next.done || !next.value?.byteLength) throw new Error("truncated host protocol stream");
      chunk = next.value;
    }
    const take = Math.min(length - offset, chunk.byteLength);
    output.set(chunk.subarray(0, take), offset);
    offset += take;
    if (take < chunk.byteLength) pending.set(reader, chunk.subarray(take));
    else pending.delete(reader);
  }
  return output;
}

export async function readJsonFrame(reader: ByteReader): Promise<unknown> {
  const prefix = await readExact(reader, 4);
  const size = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, false);
  if (size > MAX_HEADER_BYTES) throw new Error("host protocol header exceeds the size limit");
  const bytes = await readExact(reader, size);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid host protocol JSON frame"); }
}

export async function readRequest(reader: ByteReader): Promise<{ request: HostRequest; payload: Uint8Array }> {
  const value = await readJsonFrame(reader);
  if (!value || typeof value !== "object") throw new Error("invalid host protocol request");
  const request = value as Partial<HostRequest>;
  if (Object.keys(value as object).some((key) => !["version", "operation", "payloadBytes", "preview"].includes(key))) throw new Error("unknown host protocol request field");
  if (request.operation !== "previewConfig" && request.preview !== undefined) throw new Error("unexpected host protocol preview field");
  if (request.version !== HOST_PROTOCOL_VERSION || !["capabilities", "exportSnapshot", "importLogs", "previewConfig"].includes(request.operation ?? "") ||
      !Number.isSafeInteger(request.payloadBytes) || request.payloadBytes! < 0 || request.payloadBytes! > MAX_HOST_PAYLOAD_BYTES) throw new Error("invalid host protocol request fields");
  if (request.operation !== "importLogs" && request.payloadBytes !== 0) throw new Error("unexpected host protocol payload");
  const payload = request.payloadBytes ? await readExact(reader, request.payloadBytes) : new Uint8Array();
  return { request: request as HostRequest, payload };
}

export function responseHeader(ok: boolean, payloadBytes = 0, result?: unknown, error?: string): HostResponse {
  return { version: HOST_PROTOCOL_VERSION, ok, payloadBytes, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
}

export async function assertEnd(reader: ByteReader): Promise<void> {
  if (pending.get(reader as object)?.byteLength) throw new Error("unexpected trailing host response bytes");
  const next = await reader.read();
  if (!next.done && next.value?.byteLength) throw new Error("unexpected trailing host response bytes");
}
