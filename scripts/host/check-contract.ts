import { createHash, randomUUID } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import { access, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyInbox } from "../../src/live/inbox.ts";
import { MAX_INBOX_BYTES, MAX_OUTBOX_BYTES, parseBundleTar, readBundle } from "../../src/live/bundle.ts";
import { writeOutbox } from "../../src/live/outbox.ts";
import { canonicalConfig } from "../../src/live/portable.ts";
import { classify } from "../../src/live/path-classes.ts";
import { makeTar } from "../../test/live/fixtures.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MARKED_PASSPHRASE = "SYNTHETIC_FIXTURE_contract_passphrase_42";
const args = process.argv.slice(2);
let rustManifest = join(root, "apps/host/Cargo.toml");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rust-manifest-path" && args[i + 1]) rustManifest = resolve(args[++i]);
  else throw new Error(`unknown argument: ${args[i]}`);
}

async function preflight(): Promise<void> {
  const age = Bun.which("age");
  if (!age) throw new Error("age 1.3.2 is required; put the pinned executable on PATH before running the contract check");
  const ageVersion = Bun.spawnSync([age, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  if (ageVersion.exitCode !== 0 || !new TextDecoder().decode(ageVersion.stdout).trim().endsWith("1.3.2")) {
    throw new Error("the contract check requires age 1.3.2; install the pinned official binary and retry");
  }
  if (!Bun.which("age-plugin-batchpass")) throw new Error("age-plugin-batchpass for age 1.3.2 is required; put the official pinned plugin on PATH before running the contract check");
  if (!Bun.which("cargo")) throw new Error("cargo is required for the cross-language contract check");
  try { await access(rustManifest); }
  catch { throw new Error(`Rust bridge manifest is unavailable: ${rustManifest}`); }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function writeAge(tar: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const age = Bun.which("age");
  assert(age, "age preflight invariant failed");
  const process = Bun.spawn([age, "-e", "-j", "batchpass"], {
    env: { ...Bun.env, AGE_PASSPHRASE_FD: "3", AGE_PASSPHRASE: undefined, AGE_PASSPHRASE_WORK_FACTOR: undefined },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const fd = process.stdio[3];
  assert(fd !== null, "age passphrase descriptor is unavailable");
  writeSync(fd, `${passphrase}\n`);
  closeSync(fd);
  process.stdin.write(tar);
  process.stdin.end();
  const timer = setTimeout(() => process.kill(), 60_000);
  try {
    const [status, stdout] = await Promise.all([process.exited, readBounded(process.stdout, 64 * 1024 * 1024, () => process.kill()), drain(process.stderr, 2048)]);
    if (status !== 0) throw new Error(`B age encryption failed with status ${status}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

async function drain(stream: ReadableStream<Uint8Array>, keep: number): Promise<void> {
  const reader = stream.getReader();
  let count = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    count += value.byteLength;
    if (count > keep) count = keep;
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, kill: () => void): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { kill(); throw new Error("cross-language helper output exceeds its size cap"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function runRust(args: string[]): Promise<void> {
  const cargo = Bun.which("cargo");
  if (!cargo) throw new Error("cargo is required for the cross-language contract check");
  const child = Bun.spawn([cargo, "run", "--quiet", "--manifest-path", rustManifest, "-p", "ais-host-core", "--features", "file-test", "--bin", "ais-host-bundle-bridge", "--", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  try {
    const [status] = await Promise.all([child.exited, drain(child.stdout, 2048), drain(child.stderr, 2048)]);
    if (status !== 0) throw new Error(`Rust bundle bridge failed with status ${status}`);
  } finally { clearTimeout(timer); }
}

const scratch = join(process.env.HOST_TEST_SCRATCH ?? process.env.TMPDIR ?? tmpdir(), "ais-host-contract", randomUUID());
await preflight();
await mkdir(scratch, { recursive: true, mode: 0o700 });
{
  const passphrasePath = join(scratch, "SYNTHETIC_FIXTURE-passphrase.txt");
  await writeFile(passphrasePath, MARKED_PASSPHRASE, { mode: 0o600 });

  // B-authored inbox plaintext is encrypted and then decrypted by Rust.
  const inboxTar = makeTar({ version: 1, seq: 7, kind: "inbox", createdAt: "2026-10-19T00:00:00.000Z" }, [
    { path: ".claude/settings.json", class: "config:settings", bytes: new TextEncoder().encode('{"theme":"synthetic"}\n') },
  ]);
  const inboxCipher = await writeAge(inboxTar, MARKED_PASSPHRASE);
  const inboxCipherPath = join(scratch, "inbox-b.age");
  const rustInboxPath = join(scratch, "rust-inbox.tar");
  await writeFile(inboxCipherPath, inboxCipher, { mode: 0o600 });
  await runRust(["read", inboxCipherPath, rustInboxPath, passphrasePath, "inbox"]);
  assert(hash(new Uint8Array(await readFile(rustInboxPath))) === hash(inboxTar), "Rust did not recover B-authored inbox tar bytes exactly");
  let wrongPassphraseRejected = false;
  try { await readBundle(inboxCipherPath, "SYNTHETIC_FIXTURE_wrong_contract_passphrase", "inbox"); }
  catch { wrongPassphraseRejected = true; }
  assert(wrongPassphraseRejected, "B accepted a bundle encrypted with a different passphrase");
  const corruptCipherPath = join(scratch, "inbox-corrupt-trailer.age");
  const corruptCipher = inboxCipher.slice();
  corruptCipher[corruptCipher.byteLength - 1] ^= 1;
  await writeFile(corruptCipherPath, corruptCipher, { mode: 0o600 });
  let corruptTrailerRejected = false;
  try { await readBundle(corruptCipherPath, MARKED_PASSPHRASE, "inbox"); }
  catch { corruptTrailerRejected = true; }
  assert(corruptTrailerRejected, "B accepted a bundle with a damaged age authentication trailer");

  // Rust encrypts the same B-authored tar; B's production readBundle uses age's
  // batchpass path, waits for authentication, then invokes B's tar validator.
  const rustCipherPath = join(scratch, "rust-inbox.age");
  await writeFile(join(scratch, "inbox.tar"), inboxTar, { mode: 0o600 });
  await runRust(["write", join(scratch, "inbox.tar"), rustCipherPath, passphrasePath, "inbox"]);
  const rustBundle = await readBundle(rustCipherPath, MARKED_PASSPHRASE, "inbox");
  assert(hash(rustBundle.tarBytes) === hash(inboxTar), "B did not recover Rust-authored inbox tar bytes exactly");
  const appliedHome = join(scratch, "applied-home");
  await mkdir(appliedHome, { recursive: true, mode: 0o700 });
  const applied = await applyInbox({
    home: appliedHome,
    tar: rustBundle.tarBytes,
    clock: { synchronized: true, imageBuildTimeMs: 0, newestPersistedMtimeMs: 0, nowMs: Date.now() },
  });
  assert(applied.lastInboxSeq === 7 && applied.applied === 1, "B did not apply the Rust-encrypted inbox sequence");

  // Rebuild the archive with Rust's manifest and tar writer, encrypt it with
  // Rust age, then consume and apply it through B's production reader.
  const rustAuthoredCipherPath = join(scratch, "rust-authored-inbox.age");
  await runRust(["repack", join(scratch, "inbox.tar"), rustAuthoredCipherPath, passphrasePath, "inbox"]);
  const rustAuthored = await readBundle(rustAuthoredCipherPath, MARKED_PASSPHRASE, "inbox");
  const rustAuthoredParsed = parseBundleTar(rustAuthored.tarBytes, "inbox");
  const expectedInbox = parseBundleTar(inboxTar, "inbox");
  assert(JSON.stringify(rustAuthoredParsed.manifest) === JSON.stringify(expectedInbox.manifest), "B parsed different manifest semantics from the Rust-authored tar");
  assert(rustAuthoredParsed.files.size === expectedInbox.files.size && [...expectedInbox.files].every(([path, bytes]) => {
    const actual = rustAuthoredParsed.files.get(path);
    return actual !== undefined && hash(actual) === hash(bytes);
  }), "B parsed different payloads from the Rust-authored tar");
  const rustAppliedHome = join(scratch, "rust-authored-applied-home");
  await mkdir(rustAppliedHome, { recursive: true, mode: 0o700 });
  const rustApplied = await applyInbox({
    home: rustAppliedHome,
    tar: rustAuthored.tarBytes,
    clock: { synchronized: true, imageBuildTimeMs: 0, newestPersistedMtimeMs: 0, nowMs: Date.now() },
  });
  assert(rustApplied.applied === 1 && rustApplied.lastInboxSeq === 7, "B did not apply and acknowledge the Rust-authored inbox sequence");

  // Exercise exact passphrase bytes in both directions, including multibyte
  // UTF-8, significant surrounding spaces, and the Rust minimum length.
  const passphraseCases = [
    { label: "unicode", passphrase: "SYNTHETIC_FIXTURE_日本語_passphrase" },
    { label: "whitespace", passphrase: "  SYNTHETIC_FIXTURE_spaced  " },
    { label: "boundary", passphrase: "SYNTHETIC_FIXTURE".slice(0, 12) },
  ];
  for (const { label, passphrase } of passphraseCases) {
    const casePassphrasePath = join(scratch, `SYNTHETIC_FIXTURE-${label}-passphrase.txt`);
    await writeFile(casePassphrasePath, passphrase, { mode: 0o600 });
    const bCipherPath = join(scratch, `SYNTHETIC_FIXTURE-${label}-b.age`);
    const rustPlainPath = join(scratch, `SYNTHETIC_FIXTURE-${label}-rust.tar`);
    await writeFile(bCipherPath, await writeAge(inboxTar, passphrase), { mode: 0o600 });
    await runRust(["read", bCipherPath, rustPlainPath, casePassphrasePath, "inbox"]);
    assert(hash(new Uint8Array(await readFile(rustPlainPath))) === hash(inboxTar), `Rust did not decrypt the ${label} B passphrase case`);

    const rustCipherPath = join(scratch, `SYNTHETIC_FIXTURE-${label}-rust.age`);
    await runRust(["write", join(scratch, "inbox.tar"), rustCipherPath, casePassphrasePath, "inbox"]);
    const bBundle = await readBundle(rustCipherPath, passphrase, "inbox");
    assert(hash(bBundle.tarBytes) === hash(inboxTar), `B did not decrypt the ${label} Rust passphrase case`);
  }

  // Ask B's real outbox collector to hash synthetic configuration and carry
  // logs. Its configuration entries are manifest-only by contract.
  const outboxHome = join(scratch, "outbox-home");
  const configPath = join(outboxHome, ".ais/config/sync-v2.json");
  const logPath = join(outboxHome, ".ais/logs/session.jsonl");
  await Bun.write(configPath, '{"enabled":true}\n');
  await Bun.write(logPath, '{"event":"SYNTHETIC_FIXTURE_log_event"}\n');
  const outbox = await writeOutbox({ home: outboxHome, lastInboxSeq: 7, now: new Date("2026-10-19T00:00:00.000Z") });
  assert(outbox.manifest.kind === "outbox" && outbox.manifest.version === 1, "B outbox manifest schema changed unexpectedly");
  assert(outbox.manifest.lastInboxSeq === 7, "B outbox does not acknowledge the applied inbox sequence");
  const configEntry = outbox.manifest.entries.find((entry) => entry.path === ".ais/config/sync-v2.json");
  const configCanonical = canonicalConfig(".ais/config/sync-v2.json", new TextEncoder().encode('{"enabled":true}\n'));
  const parsedOutbox = parseBundleTar(outbox.tarBytes, "outbox");
  assert(configEntry?.class === "config:settings" && configEntry.sha256 === hash(configCanonical) && !parsedOutbox.files.has(".ais/config/sync-v2.json"), "B outbox config entry is not a hash-only canonical entry");
  const outboxTarPath = join(scratch, "b-outbox.tar");
  const outboxCipherPath = join(scratch, "b-outbox.age");
  const rustOutboxTarPath = join(scratch, "rust-outbox.tar");
  await writeFile(outboxTarPath, outbox.tarBytes, { mode: 0o600 });
  await writeAge(outbox.tarBytes, MARKED_PASSPHRASE).then((cipher) => writeFile(outboxCipherPath, cipher, { mode: 0o600 }));
  await runRust(["read", outboxCipherPath, rustOutboxTarPath, passphrasePath, "outbox"]);
  assert(hash(new Uint8Array(await readFile(rustOutboxTarPath))) === hash(outbox.tarBytes), "Rust did not recover B-authored outbox tar bytes exactly");

  assert(MAX_INBOX_BYTES === 64 * 1024 * 1024 && MAX_OUTBOX_BYTES === 32 * 1024 * 1024, "B bundle limits changed unexpectedly");
  for (const [kind, maxBytes] of [["inbox", MAX_INBOX_BYTES], ["outbox", MAX_OUTBOX_BYTES]] as const) {
    let tarLimitRejected = false;
    try { parseBundleTar(new Uint8Array(maxBytes + 1), kind); }
    catch { tarLimitRejected = true; }
    assert(tarLimitRejected, `B parser accepted a ${kind} tar over its plaintext cap`);
    const oversizedCipherPath = join(scratch, `${kind}-oversized.age`);
    await writeFile(oversizedCipherPath, new Uint8Array(0), { mode: 0o600 });
    await truncate(oversizedCipherPath, maxBytes + 1);
    let cipherLimitRejected = false;
    try { await readBundle(oversizedCipherPath, MARKED_PASSPHRASE, kind); }
    catch { cipherLimitRejected = true; }
    assert(cipherLimitRejected, `B reader accepted ${kind} ciphertext over its size cap`);
  }

  const exportedClasses = JSON.parse(await readFile(join(root, "src/live/path-classes.json"), "utf8")) as { version?: number; sshRoot?: string; rootConfigPaths?: Record<string, string> };
  assert(exportedClasses.version === 1 && exportedClasses.sshRoot === ".ssh" && exportedClasses.rootConfigPaths?.[".codex/config.toml"] === "config:settings", "B path-class JSON export is missing expected contract values");
  const paths = [
    ".claude/settings.json", ".claude/identities.json", ".claude/identities/SYNTHETIC_FIXTURE_identity/settings.json",
    ".claude/foo-plugins/SYNTHETIC_FIXTURE_extension/index.js",
    ".claude/identities/SYNTHETIC_FIXTURE_identity/plugins/example/index.js", ".claude/plugins/example/index.js",
    ".claude/projects/plugins/SYNTHETIC_FIXTURE_session/session.jsonl", ".ais/logs/SYNTHETIC_FIXTURE_session.jsonl",
    ".codex/config.toml", ".codex/identities/SYNTHETIC_FIXTURE_identity/identities.json",
    ".claude/identities/SYNTHETIC_FIXTURE_identity/.credentials.json", ".opencode/data/opencode/auth.json",
    ".ssh/config", ".ais/memory/GLOBAL.md", ".ais/models/SYNTHETIC_FIXTURE.gguf", "unowned/file.txt",
  ];
  const classesInput = join(scratch, "paths.json");
  const classesOutput = join(scratch, "classes.json");
  await Bun.write(classesInput, JSON.stringify(paths));
  await runRust(["classify", classesInput, classesOutput]);
  const rustClasses = JSON.parse(await readFile(classesOutput, "utf8")) as Array<string | null>;
  const bClasses = paths.map((path) => { const value = classify(path); return value === "ignore" ? null : value; });
  assert(JSON.stringify(rustClasses) === JSON.stringify(bClasses), "Rust path classifier differs from B's exported class rules");
  console.log("B/Rust bundle interoperability passed: schema v1, B age batchpass, exact tar round trips, Rust-authored tar parse and apply, wrong-passphrase and trailer rejection, applied sequence, hash-only config, acknowledgement, plaintext/ciphertext caps, and path-class parity.");
}
