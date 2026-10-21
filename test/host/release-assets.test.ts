import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryTarget, checksums, components, digest, releaseFiles, validateTrustKey, validatePayloadNames, verifyChecksums, verifyPayload } from "../../scripts/host/release-assets";

describe("portable release contents", () => {
  test("identifies the architecture from bytes rather than filenames", () => {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    expect(binaryTarget(elf)).toBe("linux-x64");
    const macho = Buffer.alloc(32);
    macho.writeUInt32LE(0xfeedfacf, 0);
    macho.writeUInt32LE(0x0100000c, 4);
    expect(binaryTarget(macho)).toBe("macos-arm64");
    macho.writeUInt32LE(0x01000007, 4);
    expect(() => binaryTarget(macho)).toThrow();
    const pe = Buffer.alloc(160);
    pe.write("MZ");
    pe.writeUInt32LE(64, 60);
    pe.write("PE\0\0", 64);
    pe.writeUInt16LE(0x8664, 68);
    expect(binaryTarget(pe)).toBe("windows-x64");
    expect(() => binaryTarget(Buffer.from("SYNTHETIC_FIXTURE"))).toThrow();
  });
  test("requires the adapter, helper, cleanup utility, trust key and notices", () => {
    const files = ["ais-host-app", "ais-host-adapter", "ais-host-helper", "ais-host-escrow-purge", "release-key.pub", "THIRD-PARTY-NOTICES.txt", "LICENSE", "host-build.json"];
    expect(() => validatePayloadNames(files, "linux-x64")).not.toThrow();
    for (const name of files) expect(() => validatePayloadNames(files.filter((f) => f !== name), "linux-x64")).toThrow();
    for (const name of ["host-file-check", "ais-host-bundle-bridge", "fixture.json", "../escape", "credentials.json"]) {
      expect(() => validatePayloadNames([...files, name], "linux-x64")).toThrow();
    }
  });
  test("a release cannot use an empty, malformed or development trust key", () => {
    for (const key of ["", "SYNTHETIC_FIXTURE", "untrusted comment: placeholder\ninvalid"]) {
      expect(() => validateTrustKey(key)).toThrow();
    }
    const publicPacket = Buffer.alloc(42, 7);
    publicPacket.write("Ed");
    expect(() => validateTrustKey(`untrusted comment: public key\n${publicPacket.toString("base64")}\n`)).not.toThrow();
  });
  test("checksums cover the final distributed bytes and reject ambiguous names", () => {
    const oldBytes = Buffer.from("before signing");
    const finalBytes = Buffer.from("after signing and stapling");
    expect(checksums([{ name: "ais-host.zip", bytes: finalBytes }])).not.toBe(checksums([{ name: "ais-host.zip", bytes: oldBytes }]));
    expect(checksums([{ name: "ais-host.zip", bytes: finalBytes }])).toMatch(/^[a-f0-9]{64}  ais-host\.zip\n$/);
    expect(() => checksums([{ name: "../escape", bytes: finalBytes }])).toThrow();
  });
  test("rejects missing assets and alterations after the final manifest was formed", () => {
    const directory = mkdtempSync(join(tmpdir(), "host-release-SYNTHETIC_FIXTURE-"));
    try {
      const files = releaseFiles.map((name) => ({ name, bytes: Buffer.from(`SYNTHETIC_FIXTURE ${name}`) }));
      for (const { name, bytes } of files) writeFileSync(join(directory, name), bytes);
      writeFileSync(join(directory, "SHA256SUMS"), checksums(files));
      expect(() => verifyChecksums(directory)).not.toThrow();
      writeFileSync(join(directory, files[0]!.name), "SYNTHETIC_FIXTURE altered after stapling");
      expect(() => verifyChecksums(directory)).toThrow();
      writeFileSync(join(directory, files[0]!.name), files[0]!.bytes);
      writeFileSync(join(directory, "SHA256SUMS"), checksums(files.slice(1)));
      expect(() => verifyChecksums(directory)).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("validates the pinned key, build metadata and every packaged executable", () => {
    const directory = mkdtempSync(join(tmpdir(), "host-payload-SYNTHETIC_FIXTURE-"));
    const binary = Buffer.alloc(160);
    binary.write("MZ");
    binary.writeUInt32LE(64, 60);
    binary.write("PE\0\0", 64);
    binary.writeUInt16LE(0x8664, 68);
    const metadata = { target: "windows-x64", trustKeySha256: digest(Buffer.from("")), status: "development-only",
      windowsSigning: "unsigned", features: ["custom-protocol"], privilegedHelper: "separate-authorised-installation" };
    const verify = () => verifyPayload(directory, "windows-x64", false, "");
    try {
      for (const component of components) writeFileSync(join(directory, `${component}.exe`), binary);
      for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) writeFileSync(join(directory, name), "SYNTHETIC_FIXTURE notice ".repeat(10));
      writeFileSync(join(directory, "release-key.pub"), "");
      writeFileSync(join(directory, "host-build.json"), JSON.stringify(metadata));
      expect(verify).not.toThrow();
      for (const change of [{ windowsSigning: "signed" }, { features: ["file-test"] }, { status: "release-candidate" }]) {
        writeFileSync(join(directory, "host-build.json"), JSON.stringify({ ...metadata, ...change }));
        expect(verify).toThrow();
      }
      writeFileSync(join(directory, "host-build.json"), JSON.stringify(metadata));
      writeFileSync(join(directory, "release-key.pub"), "SYNTHETIC_FIXTURE different key");
      expect(verify).toThrow();
      writeFileSync(join(directory, "release-key.pub"), "");
      writeFileSync(join(directory, "ais-host-helper.exe"), "SYNTHETIC_FIXTURE wrong architecture");
      expect(verify).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
