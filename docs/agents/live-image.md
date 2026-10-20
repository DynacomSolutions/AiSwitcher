# Live image: agent context and guard integration

## Task 5: Agent context, package installs and popup disk guard

The live image gives the `agent` user repository package access through
`ais-pacman`. AUR package installs and disk-changing commands require typed
approval in a popup owned by the separate `live` user's herdr session. Agents
must tell the user to expect the popup before requesting a guarded operation.
The root-owned context writer adds a marked block to the agent's
`~/.ais/memory/GLOBAL.md` before launch. It replaces only its own block and
preserves surrounding content.

Commands in `image/lib/ais-guard-table` have matching names in
`/usr/local/guard/bin`; each link targets `/usr/local/lib/ais-live/ais-guard`.
The `pacman` and `paru` links are special clients targeting `ais-pacman` and
`ais-aur` respectively. The profile fragment prepends that directory for
`agent`. Direct access to block devices remains root-only. The socket-activated daemon listens on
`/run/ais-guard.sock` and creates request state below `/run/ais-guard`, which
is root-owned and accessible to the `live` group for the popup reply path.
Approvals are bound to a request nonce and the daemon resolves target devices
itself.

The daemon unit does not apply filesystem or private temporary-directory
sandboxing: its agent-owned no-device subprocess must retain the agent's normal
home and `/tmp` view. The separately launched privileged disk operation owns
the stricter filesystem sandbox.

The confirmation plugin files are installed root-owned in the live user's
herdr plugin directory. The image includes `python3` for the guard clients and
daemon. The Task 4 image setup must retain those files when it creates the
account, then as `live` run `herdr plugin link <absolute-plugin-path> --enabled`
and `herdr plugin enable ais-guard`. Herdr's sole socket must be under
`/run/user/<live-uid>/herdr.sock`, with the live runtime directory mode 0700
and the socket mode 0600. The daemon discovers that sole named socket and
passes it as `HERDR_SOCKET_PATH`; setting `XDG_RUNTIME_DIR` alone does not
select the socket. The daemon opens its `confirm` entrypoint with
`herdr plugin pane open --plugin ais-guard --entrypoint confirm --placement popup`.
The entrypoint delegates to `/usr/local/lib/ais-live/ais-guard-popup`.

The popup must show the complete command and arguments; the user authorises the
entire displayed argument vector when approving. Inspect every argument before
approval. The disk-operation sandbox limits writes through its filesystem
protections, but it does not limit reads: an approved command with unrelated
file operands can expose root-readable contents to the agent. This is an
inherent concern with the approved full-argv root execution contract; no
unapproved-execution route has been found.

The guard fails closed when approval is absent, invalid, times out, or the
popup cannot be opened. Popup opening and text collection have not yet been
validated in QEMU. Image acceptance remains incomplete until that end-to-end
check passes. This does not make root-run package scripts safe:
repository package installs and AUR package installation run install scripts
with root-equivalent effects, while AUR build scripts run as `agent`. Review
the package source and requested operation before approving. The popup also
depends on herdr's ability to open a popup in the live session; the image must
not boot with an unverified or unavailable approval path.

## Task 6: Exchange partition

The live image's exchange partition uses authenticated age bundles and the
drive-side `ais live` commands. The bundle format and merge rules are documented
in the live-drive peer section of [sync.md](sync.md).

### Bundle and service contract

The root inbox service obtains its passphrase from the root user's keyring under
the description `ais-live-exchange`. It decrypts to a root-only temporary file
in `/run`, enforces the 64 MiB inbox bound, waits for age to report successful
authentication, and then reads only bounded first-entry manifest metadata from
the authenticated tar. It compares the inbox sequence with the root-owned
counter in `/mnt/persist/ais-live-exchange/applied-inbox-seq.json` and invokes
`runuser -u agent -- ais live apply-inbox --stdin --last-inbox-seq=N` with the
verified tar on standard input. The root counter advances atomically only after
the apply command succeeds. Root does not interpret manifest paths or write
profile data. The image build records its UTC build time
at `/etc/ais/image-build-time` as ISO 8601 or Unix seconds.

The agent-side `ais live write-outbox` emits binary tar bytes on standard output
and sends no status text there. The root service reserves and fsyncs the next
outbox sequence in `/mnt/persist/ais-live-exchange/outbox-seq.json`, then passes
`--seq=N --last-inbox-seq=N` to the agent and checks that the returned manifest
uses the reserved sequence. A failed collection or publish can leave a gap. On
first use, the root counter starts at zero and ignores exchange-partition
filenames; it logs that foreign files were ignored because filenames are not
authenticated sequence state.
The root service encrypts the tar, publishes only a complete ciphertext through
a temporary file and atomic rename on the exchange partition, and enforces the
32 MiB ciphertext ceiling. The keyring
entry remains available until the shutdown outbox operation completes; shutdown
then revokes the key and unmounts the partition. The outbox timer runs every
fifteen minutes. Neither command runs automatically during ordinary CLI startup.

The two root counters are mode 0700/0600 state outside the `@config` snapshot
and are atomically replaced with file and directory fsync. Restoring a home or
exchange snapshot, or deleting a visible outbox bundle, cannot lower these
authoritative counters. The agent's home cache remains useful for standalone
CLI calls, but the root protocol always supplies sequence overrides.

The bundle manifest is versioned and sequence-numbered. Agent inbox state retains the
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
