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
