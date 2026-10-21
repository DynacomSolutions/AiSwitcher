import { describe, expect, test } from "bun:test";
import { dependentLoadFlags } from "../../scripts/host/pe-load-flags";

// A minimal 64-bit PE image: one section holding a load configuration directory.
function image(flags: number, directorySize = 0x90): Buffer {
  const bytes = Buffer.alloc(0x600);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(1, 0x80 + 6); // sections
  bytes.writeUInt16LE(240, 0x80 + 20); // optional header size
  const optional = 0x80 + 24;
  bytes.writeUInt16LE(0x20b, optional);
  const entry = optional + 112 + 10 * 8;
  bytes.writeUInt32LE(0x2000, entry); // load config RVA
  bytes.writeUInt32LE(directorySize, entry + 4);
  const section = optional + 240;
  bytes.writeUInt32LE(0x200, section + 8); // virtual size
  bytes.writeUInt32LE(0x2000, section + 12); // virtual address
  bytes.writeUInt32LE(0x200, section + 16); // raw size
  bytes.writeUInt32LE(0x400, section + 20); // raw offset
  bytes.writeUInt16LE(flags, 0x400 + 78);
  return bytes;
}

describe("PE dependent load flags", () => {
  test("reads the flags the linker recorded", () => {
    expect(dependentLoadFlags(image(0x800))).toBe(0x800);
    expect(dependentLoadFlags(image(0))).toBe(0);
  });
  test("an image without the field reports none", () => {
    expect(dependentLoadFlags(image(0x800, 0x40))).toBeUndefined();
  });
  test("refuses non-PE input", () => {
    expect(() => dependentLoadFlags(Buffer.alloc(0x100))).toThrow();
  });
});
