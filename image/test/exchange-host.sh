#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly FIXTURE_PASS_ENV=${AIS_EXCHANGE_TEST_PASSPHRASE:?set a synthetic fixture passphrase in the environment}
[[ $FIXTURE_PASS_ENV == *SYNTHETIC_FIXTURE* ]] || { printf '%s\n' 'fixture passphrase must be synthetic' >&2; exit 64; }
readonly MAX_OUTBOX_BYTES=$((32 * 1024 * 1024))

usage() {
  printf '%s\n' \
    'usage: exchange-host.sh fixture <inbox|auth|crafted|tamper> <exchange-root>' \
    '       exchange-host.sh verify-outbox <encrypted-file> <last-inbox-seq>' \
    '       exchange-host.sh exfat-readback <partition-device> <expected-bundle-name>' >&2
}

encrypt_fixture() {
  local kind=$1 root=$2 seq=$3 tempdir encrypted
  [[ $root == /* && -d $root ]] || { printf '%s\n' 'exchange root must be an existing mounted directory' >&2; return 64; }
  mkdir -p -- "$root/inbox"
  tempdir=$(mktemp -d "${TMPDIR:-/tmp}/ais-exchange-fixture.XXXXXXXX")
  node "$SCRIPT_DIR/exchange-fixtures.mjs" "$tempdir" "$kind"
  encrypted=$root/inbox/.fixture-"$seq".age.tmp
  if ! env -u AGE_PASSPHRASE -u AGE_PASSPHRASE_WORK_FACTOR AGE_PASSPHRASE_FD=3 \
    age -e -j batchpass <"$tempdir/bundle.tar" >"$encrypted" 3<<<"$FIXTURE_PASS_ENV"; then
    printf '%s\n' 'age fixture encryption failed' >&2
    return 1
  fi
  if [[ $kind == tamper ]]; then
    node - "$encrypted" <<'JS'
const fs = require("node:fs");
const path = process.argv[2];
const fd = fs.openSync(path, "r+");
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size < 128) throw new Error("age fixture is unexpectedly short");
  const byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, stat.size - 1);
  byte[0] ^= 1;
  fs.writeSync(fd, byte, 0, 1, stat.size - 1);
  fs.fsyncSync(fd);
} finally { fs.closeSync(fd); }
JS
  fi
  mv -T -- "$encrypted" "$root/inbox/bundle-$seq.age"
  printf 'fixture ready: bundle-%s.age\n' "$seq"
}

verify_outbox() {
  local source=$1 expected_seq=$2 size tempdir plain
  [[ -f $source && ! -L $source ]] || { printf '%s\n' 'outbox source must be a regular file' >&2; return 1; }
  size=$(stat -c '%s' -- "$source")
  if [[ ! $size =~ ^[0-9]+$ ]] || (( size > MAX_OUTBOX_BYTES )); then printf '%s\n' 'encrypted outbox exceeds its size limit' >&2; return 1; fi
  tempdir=$(mktemp -d "${TMPDIR:-/tmp}/ais-exchange-verify.XXXXXXXX")
  plain=$tempdir/outbox.tar
  if ! env -u AGE_PASSPHRASE -u AGE_PASSPHRASE_WORK_FACTOR AGE_PASSPHRASE_FD=3 \
    age -d -j batchpass <"$source" >"$plain" 3<<<"$FIXTURE_PASS_ENV"; then
    printf '%s\n' 'outbox authentication failed' >&2
    return 1
  fi
  size=$(stat -c '%s' -- "$plain")
  if [[ ! $size =~ ^[0-9]+$ ]] || (( size > MAX_OUTBOX_BYTES )); then printf '%s\n' 'decrypted outbox exceeds its size limit' >&2; return 1; fi
  node - "$plain" "$expected_seq" <<'JS'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = process.argv[2];
const expectedSeq = Number(process.argv[3]);
const fd = fs.openSync(path, "r");
try {
  const header = Buffer.alloc(512);
  if (fs.readSync(fd, header, 0, 512, 0) !== 512 || header[156] !== 0 && header[156] !== 48) throw new Error("manifest tar entry missing");
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
  if (name !== "manifest.json" || !/^[0-7]+$/.test(sizeText)) throw new Error("manifest is not first in the tar");
  const manifestSize = Number.parseInt(sizeText, 8);
  if (!Number.isSafeInteger(manifestSize) || manifestSize > 1024 * 1024) throw new Error("manifest size invalid");
  const payload = Buffer.alloc(manifestSize);
  if (fs.readSync(fd, payload, 0, manifestSize, 512) !== manifestSize) throw new Error("manifest is truncated");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (manifest.kind !== "outbox" || manifest.lastInboxSeq !== expectedSeq || !Number.isSafeInteger(manifest.seq) || manifest.seq < 1 || !Array.isArray(manifest.entries)) throw new Error("outbox manifest state does not match");
  if (!Number.isSafeInteger(manifest.skippedSymlinks) || manifest.skippedSymlinks < 2) throw new Error("symlink skips were not recorded");
  const listed = new Map();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.class !== "string" ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("outbox manifest entry is malformed");
    if (entry.class === "auth" || /(?:^|\/)\.credentials\.json$/i.test(entry.path)) throw new Error("outbox manifest contains an auth entry");
    if (listed.has(entry.path)) throw new Error("outbox manifest contains a duplicate path");
    listed.set(entry.path, entry);
  }
  const logEntry = manifest.entries.find((entry) => entry.class === "logs" && entry.size > 0);
  if (!logEntry) throw new Error("outbox has no verifiable log entry");
  let offset = 512 + Math.ceil(manifestSize / 512) * 512;
  let foundLog = false;
  const seenPayloads = new Set();
  while (offset + 512 <= fs.fstatSync(fd).size) {
    const entryHeader = Buffer.alloc(512);
    if (fs.readSync(fd, entryHeader, 0, 512, offset) !== 512) break;
    if (entryHeader.every((byte) => byte === 0)) break;
    const name = entryHeader.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = entryHeader.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const pathName = prefix ? `${prefix}/${name}` : name;
    const type = entryHeader[156];
    const sizeText = entryHeader.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    if (type !== 0 && type !== 48 || !/^[0-7]+$/.test(sizeText)) throw new Error("unexpected non-regular outbox tar entry");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) throw new Error("outbox entry size invalid");
    const content = Buffer.alloc(size);
    if (fs.readSync(fd, content, 0, size, offset + 512) !== size) throw new Error("outbox entry truncated");
    if (pathName === "manifest.json") throw new Error("outbox contains a duplicate manifest");
    if (/(?:^|\/)\.credentials\.json$/i.test(pathName) || content.includes(Buffer.from("SYNTHETIC_FIXTURE_exchange_auth_token")) || content.includes(Buffer.from("SYNTHETIC_FIXTURE_exchange_refresh_token"))) throw new Error("outbox contains an auth payload");
    const entry = listed.get(pathName);
    if (!entry || entry.class !== "logs") throw new Error(`unlisted or non-log payload in outbox: ${pathName}`);
    if (seenPayloads.has(pathName)) throw new Error(`duplicate outbox payload: ${pathName}`);
    seenPayloads.add(pathName);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    if (digest !== entry.sha256 || content.length !== entry.size) throw new Error(`outbox payload does not match its manifest: ${pathName}`);
    if (pathName === logEntry.path) {
      foundLog = true;
      if (!content.includes(Buffer.from("SYNTHETIC_FIXTURE_"))) throw new Error("outbox log lacks the synthetic fixture marker");
    }
    if (content.includes(Buffer.from("SYNTHETIC_FIXTURE_external"))) throw new Error("outbox contains the symlink target sentinel");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!foundLog) throw new Error("manifest log entry was not present in archive");
  for (const entry of manifest.entries) {
    if (entry.class === "logs" && !seenPayloads.has(entry.path)) throw new Error(`manifest log payload is missing: ${entry.path}`);
    if (entry.class !== "logs" && entry.class !== "config:settings" && entry.class !== "config:plugins" && entry.class !== "config:identity") throw new Error(`unexpected outbox manifest class: ${entry.class}`);
    if (entry.class.startsWith("config:") && seenPayloads.has(entry.path)) throw new Error(`configuration bytes must not be exported: ${entry.path}`);
  }
  process.stdout.write(`outbox verified: seq=${manifest.seq} lastInboxSeq=${manifest.lastInboxSeq} log=${logEntry.path} skippedSymlinks=${manifest.skippedSymlinks}\n`);
} finally { fs.closeSync(fd); }
JS
}

exfat_readback() {
  local device=$1 expected=$2 mount_dir
  [[ -b $device ]] || { printf '%s\n' 'exFAT readback requires the runner-provided partition block device' >&2; return 64; }
  [[ $expected =~ ^bundle-[1-9][0-9]{0,15}\.age$ ]] || { printf '%s\n' 'invalid expected bundle name' >&2; return 64; }
  fsck.exfat -n "$device"
  mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/ais-exchange-exfat.XXXXXXXX")
  mount -t exfat -o ro,nosuid,nodev,noexec "$device" "$mount_dir"
  [[ -f $mount_dir/outbox/$expected && ! -L $mount_dir/outbox/$expected ]] || { umount "$mount_dir"; printf '%s\n' 'expected outbox bundle is absent on exFAT readback' >&2; return 1; }
  umount "$mount_dir"
  printf 'exFAT readback verified: %s\n' "$expected"
}

case ${1:-} in
  fixture)
    (($# == 3)) || { usage; exit 64; }
    case $2 in
      inbox) encrypt_fixture inbox "$3" 1 ;;
      auth) encrypt_fixture auth "$3" 4 ;;
      crafted) encrypt_fixture crafted "$3" 5 ;;
      tamper) encrypt_fixture tamper "$3" 2 ;;
      *) usage; exit 64 ;;
    esac
    ;;
  verify-outbox)
    (($# == 3)) || { usage; exit 64; }
    verify_outbox "$2" "$3"
    ;;
  exfat-readback)
    (($# == 3)) || { usage; exit 64; }
    exfat_readback "$2" "$3"
    ;;
  *) usage; exit 64 ;;
esac
