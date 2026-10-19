import { createHash } from "node:crypto";

export function makeTar(manifest: Record<string, unknown>, payloads: Array<{ path: string; class: string; bytes: Uint8Array; type?: number; sha256?: string }>): Uint8Array {
  const entries = payloads.map(({ path, class: entryClass, bytes, sha256 }) => ({ path, class: entryClass, sha256: sha256 ?? createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength }));
  const manifestBytes = new TextEncoder().encode(JSON.stringify({ version: 1, seq: 1, createdAt: "2026-10-19T00:00:00Z", kind: "inbox", entries, ...manifest }));
  const files = [{ path: "manifest.json", bytes: manifestBytes, type: 48 }, ...payloads.map(({ path, bytes, type }) => ({ path, bytes, type: type ?? 48 }))];
  const chunks: Uint8Array[] = [];
  for (const { path, bytes, type } of files) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(path), 0);
    octal(header, 100, 8, 0o600); octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, bytes.byteLength); octal(header, 136, 12, 0);
    header.fill(32, 148, 156); header[156] = type; header.set(new TextEncoder().encode("ustar\0"), 257); header.set(new TextEncoder().encode("00"), 263);
    let sum = 0; for (const value of header) sum += value;
    header.set(new TextEncoder().encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 512) * 512); padded.set(bytes);
    chunks.push(header, padded);
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0; for (const chunk of chunks) { tar.set(chunk, offset); offset += chunk.byteLength; }
  return tar;
}

function octal(header: Uint8Array, start: number, size: number, value: number): void {
  header.set(new TextEncoder().encode(value.toString(8).padStart(size - 1, "0") + "\0"), start);
}
