import { readFileSync } from "node:fs";

/** LOAD_LIBRARY_SEARCH_SYSTEM32: imports resolve from System32 only. */
export const SEARCH_SYSTEM32 = 0x800;

/**
 * The DependentLoadFlags of a 64-bit PE image (IMAGE_LOAD_CONFIG_DIRECTORY64),
 * which the linker sets from /DEPENDENTLOADFLAG. Undefined when the image has
 * no load configuration that carries the field.
 */
export function dependentLoadFlags(bytes: Buffer): number | undefined {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Not a PE image.");
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Not a PE image.");
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error("Not a 64-bit PE image.");
  // Data directory 10 is the load configuration; each entry is 8 bytes.
  const entry = optional + 112 + 10 * 8;
  const rva = bytes.readUInt32LE(entry);
  const size = bytes.readUInt32LE(entry + 4);
  if (rva === 0 || size < 80) return undefined;
  const sections = optional + optionalSize;
  for (let index = 0; index < sectionCount; index++) {
    const header = sections + index * 40;
    const virtualSize = bytes.readUInt32LE(header + 8);
    const virtualAddress = bytes.readUInt32LE(header + 12);
    const rawSize = bytes.readUInt32LE(header + 16);
    const rawOffset = bytes.readUInt32LE(header + 20);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return bytes.readUInt16LE(rawOffset + (rva - virtualAddress) + 78);
    }
  }
  return undefined;
}

export function requireSearchSystem32(path: string): void {
  const flags = dependentLoadFlags(readFileSync(path));
  if (flags === undefined || (flags & SEARCH_SYSTEM32) !== SEARCH_SYSTEM32) {
    throw new Error(`${path} must be linked with /DEPENDENTLOADFLAG:0x800 (found ${flags === undefined ? "none" : `0x${flags.toString(16)}`}).`);
  }
}

if (import.meta.main) {
  const path = Bun.argv[2];
  if (!path) throw new Error("Usage: pe-load-flags.ts <executable>");
  requireSearchSystem32(path);
  console.log(`${path}: DependentLoadFlags include LOAD_LIBRARY_SEARCH_SYSTEM32.`);
}
