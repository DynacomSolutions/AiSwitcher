# Portable host app

The host app uses the live image's encrypted exchange format. Keep the Rust
bundle parser and the live image parser aligned through the synthetic
cross-language checks in `scripts/host/check-contract.ts`; never update one side
from this prose alone.

## Task 2 bundle contract

The current B implementation exports bundle version 1. A bundle is an ordinary
USTAR archive with `manifest.json` as its first root entry, zero or more
manifest-listed regular-file payloads at home-relative paths, then two zero
blocks. The manifest core is `{ version, seq, createdAt, kind, entries }`.
`createdAt` is an ISO-8601 UTC timestamp. Each entry is `{ path, class, sha256,
size }`. Outboxes additionally include `lastInboxSeq`, `truncated` and
`skippedSymlinks`. `lastInboxSeq` is only the last inbox sequence successfully
applied by the drive. It does not acknowledge outbox import, image activation
or package restoration. Inbox and outbox sequence spaces are independent,
positive safe integers.

Consume `src/live/path-classes.json` as the class export. Its version is 1 and
the payload classes are `auth`, `logs`, `config:settings`, `config:plugins`,
`config:identity` and `ssh`. `ignore` paths are excluded. Model weights are not
bundle entries. Do not reproduce or extend this class list in the host app.

B's `writeOutbox` emits logs as payloads and config entries as hash-only
manifest records. Config hashes and sizes describe `canonicalConfig(path,
bytes)`, not necessarily the source file's exact byte representation. Auth,
SSH and ignored paths are excluded from an outbox. The Rust parser must permit
manifest-only entries only for the supported outbox config classes. Every
payload must have exactly one manifest entry, and every payload digest and size
must match its manifest entry.

The inbox limit is 64 MiB for both encrypted ciphertext and decrypted tar. The
outbox limit is 32 MiB for both ciphertext and plaintext tar. B checks the
ciphertext length before invoking age, bounds decrypted output, and validates
the tar against the same kind-specific limit. `writeOutbox` checks the tar and,
when an encryptor is supplied, the encrypted result. Do not interpret these
values as payload-only limits.

Bundles use age passphrase encryption with the default scrypt work factor.
The live image's non-interactive path uses age 1.3.2 with the `batchpass`
plugin, reading the passphrase from file descriptor 3; it unsets the age
passphrase and work-factor environment overrides. Rust uses age 0.11.5 and the
default scrypt recipient. The passphrase is never part of the adapter protocol,
SSH command, child arguments, logs or diagnostics. The interoperability check
uses only a marked synthetic passphrase and generated test data.

The interoperability checker requires the official age 1.3.2 executable and
matching `age-plugin-batchpass` on `PATH`, plus Cargo and a workspace manifest
containing the development-only Rust bridge. It checks these dependencies
before creating fixtures or invoking encryption. The image and CI pipeline must
also include the matching batchpass plugin wherever the live image runs exchange.

Run `bun run scripts/host/check-contract.ts` to exercise B-authored archives
through the Rust bridge, Rust-authored tar and age output through B's actual
reader, bundle parser and inbox applier, and exact archive round trips. The
checker also runs B's actual `writeOutbox` against a synthetic home and verifies
hash-only configuration, wrong-passphrase and damaged-trailer rejection, both plaintext and ciphertext
limits, the class JSON export and `lastInboxSeq`. During local work on the Rust bridge,
an alternate Cargo manifest may be supplied with
`--rust-manifest-path <path>`. Keep the default pointed at the application
workspace manifest so the check remains reproducible after integration.

The private adapter stream is a 4-byte unsigned big-endian JSON header length,
the UTF-8 JSON header, then exactly the declared number of raw payload bytes.
Headers are limited to 64 KiB and payloads to 64 MiB. Requests use protocol
version 1 and one of `capabilities`, `exportSnapshot`, `importLogs` or
`previewConfig`. Only `importLogs` carries raw request bytes; preview data stays
in the JSON header. Responses carry `{ version, ok, payloadBytes, result? }`
or `{ version, ok: false, payloadBytes: 0, error }`, followed by the declared
response bytes. Remote operations use the fixed command `ais host --stdio`.
SSH must use batch authentication and strict host-key checking, with no
passphrase or caller-controlled shell command in the remote command string.

The isolated SSH integration harness uses externally supplied synthetic keys,
an ephemeral local sshd and a temporary strict known-hosts file. It does not
read the user's SSH configuration, account registry or network credentials.
A host without an available unprivileged sshd can run the pure protocol tests,
but that is not evidence that the SSH integration passed.

For QEMU image runs, `image/test/host-exchange.sh` wraps fixture staging,
outbox verification and exFAT readback, and provides `wait-case` for the
runner's serial channel. The runner requests each phase through its test-only
guest control path, then passes the serial channel and expected case name to
`wait-case`, which reuses the marker checks in `exchange.exp`. The runner owns
QEMU boot, RTC changes, partition staging and poweroff. QEMU scenarios remain
pending until run against the built image. Native Windows x86_64 and macOS arm64
execution are also pending.

## Write flow and release key

The create route lists only removable, non-system, writable USB drives, shows
model, size, connection and serial, and requires the exact displayed device
identifier (90 second expiry; refresh, a changed target or leaving the view
invalidates the native ticket). `start_write` takes only the preview id: native
state re-observes the device, consumes the ticket against the retained
`WritePlan` and verified image, and builds one helper request. Production
launching requires the retained image-source transport, installed helper package
and release trust anchor. The Linux final stages, `service::write_confirmed`
and `service::create_confirmed`, share the retained-target writer with the
regular-file tests; no test target is a device node.

The production minisign public key is `image/release-key.pub`, created by the B
image-release task. Until it exists the bundled key is empty (placeholder), the
image verifier fails closed, and `crates/core/build.rs` refuses a release-profile
build unless `AIS_ALLOW_PLACEHOLDER_RELEASE_KEY` is set for development.

## Create flow

The create route collects a session-only passphrase (12 characters minimum,
confirmed) and an explicit yes/no model choice; the licence text is shown before
acceptance. `create.rs` validates these and the capacity budget: image, selected
model, 512 MiB of exchange headroom and the existing 2 GiB persist reserve.
`preview_write` verifies the release and optional pinned model download, compares
the helper's fresh observation with the retained listing (including serial,
model, size and connection identity), and installs the native preview. The UI
shows that plan's observation. It consumes
the chosen options once; refresh or edits cancel a preview still being prepared.
Both GPT copies describe the expanded p4 and a Linux LUKS-type p5 occupying the
remaining reserve. Creation generates a fresh disk GUID and five fresh PARTUUIDs.
The writer zeroes all of p5 without creating a header or filesystem and patches
the three GRUB and three Syslinux ESP entries with the p3/p4/p5 identities,
the base PARTUUID path and `copytoram=n`. Readback checks both GPT copies and
both menus. All image, ESP, exchange and persistence ranges and generated IDs
belong to the confirmation digest.

Before launching the helper, `start_write` exports and encrypts the first inbox
and copies the retained model into a sealed private snapshot, checking the copy's
size and hash. The Linux helper checks every received frame's SCM_CREDENTIALS
against SO_PEERCRED and rechecks the pinned executable before every target write.
It prepares exFAT using the
system `mkfs.exfat` and `fsck.exfat`, verifies and seals a fresh anonymous regular
file, then writes only its metadata extents through the approved, locked target.
It flushes and reads back every extent, checks the final GPT and asks the kernel
to re-read the partition table. Missing or failed formatting tools stop before
imaging. Formatter processes never receive a device path.

The app checks the connection, partition bounds, AISX label and exFAT type before
mounting with udisks. It retains a directory descriptor whose filesystem type and
device match the formatted partition. All publication uses no-follow,
descriptor-relative operations. It publishes `inbox/bundle-1.age` and optional
public weights under `models/` through private staging files, bounds the model
copy, flushes and verifies staged bytes before rename, and removes failed partial
files. It decrypts the inbox and checks the model hash on readback, then unmounts
and powers off the drive. Records use USB serial/model and generated GPT IDs,
so reconnecting with a new disk sequence does not change the drive handle.
Only then does `PassphraseSink::hand_over` record it through the escrow service.
Retention remains disabled by default, so the passphrase stays session-only.
Every failed stage consumes confirmation and leaves no ready drive record.

The Linux file smoke tests exercise the actual image/exFAT helper writer with
signed synthetic releases, regular target files and a directory mount seam.
They require exfatprogs on PATH or `AIS_HOST_TEST_EXFAT_TOOLS` pointing at its
binary directory. They do not exercise native mounting, elevation, eject,
credential stores or first boot. Native checks still require the installed
root-owned package and a real release key.
