#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [outputDirectory, scenario] = process.argv.slice(2);
if (!outputDirectory || !["inbox", "auth", "crafted", "tamper"].includes(scenario)) {
  process.stderr.write("usage: exchange-fixtures.mjs <output-directory> inbox|auth|crafted|tamper\n");
  process.exit(64);
}

const fixture = (suffix) => `SYNTHETIC_FIXTURE_exchange_${suffix}`;
const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;
function tarEntry(name, content, type = "0", linkName = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o600, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(content.length, 12), 124, "ascii");
  header.write(octal(1_798_000_000, 12), 136, "ascii");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ";
  header.write(checksum, 148, "ascii");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

const isAuth = scenario === "auth";
const isCrafted = scenario === "crafted";
const payloadPath = isAuth ? ".claude/.credentials.json" : ".claude/identities/SYNTHETIC_FIXTURE_exchange/settings.json";
const payload = Buffer.from(isAuth
  ? JSON.stringify({ access_token: fixture("auth_token"), refresh_token: fixture("refresh_token"), minted_at: "2026-10-19T00:00:00.000Z" }) + "\n"
  : JSON.stringify({ probe: fixture("config") }) + "\n");
const manifest = Buffer.from(JSON.stringify({
  version: 1,
  seq: scenario === "inbox" ? 1 : scenario === "auth" ? 4 : scenario === "crafted" ? 5 : 2,
  createdAt: "2026-10-19T00:00:00.000Z",
  kind: "inbox",
  entries: isCrafted ? [] : [{
    path: payloadPath,
    class: isAuth ? "auth" : "config:settings",
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.length,
  }],
}));
const blocks = [tarEntry("manifest.json", manifest)];
if (isCrafted) {
  blocks.push(tarEntry(".claude/identities/SYNTHETIC_FIXTURE_exchange", Buffer.alloc(0), "2", "/run/ais-exchange-test/outside"));
  blocks.push(tarEntry(".claude/identities/SYNTHETIC_FIXTURE_exchange/settings.json", payload));
} else {
  blocks.push(tarEntry(payloadPath, payload));
}
blocks.push(Buffer.alloc(1024));
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "bundle.tar"), Buffer.concat(blocks), { mode: 0o600 });
