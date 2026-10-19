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
