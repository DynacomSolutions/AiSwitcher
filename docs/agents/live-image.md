# Live image integration notes

The live image's exchange partition uses authenticated age bundles and the
drive-side `ais live` commands. The bundle format and merge rules are documented
in the live-drive peer section of [sync.md](sync.md).

## Bundle and service contract

The root inbox service obtains its passphrase from the root user's keyring under
the description `ais-live-exchange`. It decrypts to a root-only temporary file
in `/run`, enforces the 64 MiB inbox bound, waits for age to report successful
authentication, and then invokes `runuser -u agent -- ais live apply-inbox
--stdin` with the verified tar on standard input. Root does not interpret
manifest paths or write profile data. The image build records its UTC build time
at `/etc/ais/image-build-time` as ISO 8601 or Unix seconds.

The agent-side `ais live write-outbox` emits binary tar bytes on standard output
and sends no status text there. The root service encrypts those bytes, publishes
only a complete ciphertext through a temporary file and atomic rename on the
exchange partition, and enforces the 32 MiB ciphertext ceiling. The keyring
entry remains available until the shutdown outbox operation completes; shutdown
then revokes the key and unmounts the partition. The outbox timer runs every
fifteen minutes. Neither command runs automatically during ordinary CLI startup.

The bundle manifest is versioned and sequence-numbered. Inbox state retains the
last applied sequence and baseline hashes for portable configuration. Outbox
manifests include the last inbox sequence, config hashes, recent selected logs,
`truncated`, and `skippedSymlinks`. Credentials and configuration bytes are
excluded from outbox payloads. Inbox application accepts only regular tar files
and completes authentication before any merge is attempted.

The non-interactive age proof uses age 1.3.2 with the batchpass plugin and a
passphrase on file descriptor 3, without a controlling terminal. Rust age 0.11.5
decrypted the resulting default scrypt stanza and matched the reference
plaintext. The package archive is pinned separately by the image build; the
minimum supported age version is 1.3.
