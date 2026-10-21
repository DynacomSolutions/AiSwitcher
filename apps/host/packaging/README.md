# Portable packages

Build with `scripts/host/build-release.ts` on the native target. The workflow
pins Bun and the Tauri CLI; Cargo uses the workspace toolchain and lockfile.
Only `custom-protocol` is enabled. Development packages without the image
trust key are labelled development-only and refuse image verification.

The macOS arm64 application contains its helper, adapter and escrow cleanup
utility in `Contents/MacOS`. The Rust executables receive hardened runtime
signatures without extra entitlements. Only the Bun adapter receives
`allow-jit`, for JavaScriptCore. No library-validation or unsigned-executable
memory exception is granted. Signing starts with nested executables, signs
the application last, notarises a temporary archive, staples the application,
then creates the final archive. No application contents change afterwards.

On macOS the helper runs as root only after the system administrator prompt
(`osascript`, fixed argv). The root command line copies the helper into a fresh
root-owned directory, verifies that copy against the application's Developer ID
team requirement, and runs the copy. The helper accepts one peer: the invoking
user's process whose kernel audit token passes the same requirement (checked
again before every write). Unsigned or development builds list drives but
refuse to write.

Windows x86_64 ships a per-machine NSIS installer (`ais-host-windows-x64-setup.exe`,
installed under `%ProgramFiles%`) and a portable ZIP. Windows signing is
deferred, so neither carries an Authenticode signature yet and SmartScreen or
the UAC prompt shows an unknown publisher. WebView2 must already be available.

Listing USB drives needs no elevation and works from either package. Writing
works only from the installer. Before it shows a UAC prompt the application
reads the DACLs of the helper, its directory and every directory above it, and
refuses unless only SYSTEM, Administrators and TrustedInstaller own them and
can write, delete or re-permission them (the C:\ root's "create folders" for
Authenticated Users is tolerated, as it cannot replace entries). A portable
copy in a user-writable folder therefore cannot elevate a replaced helper. The
helper is also linked with `/DEPENDENTLOADFLAG:0x800` (checked by the release
build) and restricts its own DLL search to System32.

The helper starts elevated through UAC (`runas`) only when a preview or write
begins. It creates a named pipe whose DACL admits the launching user's SID
alone (first instance, no remote clients) and accepts one client: the process
whose image is the application beside it, rechecked before each volume is
locked. The application accepts only the process it launched. Other processes
running as the same user are inside the trust boundary: they can run the
application too, as the user, and the typed confirmation, single-use ticket and
plan digest are what stand between that and a write. The helper takes a disk
number, never a path, re-validates the disk itself and checks the device number
again on the handle it writes. After a create it formats the new exchange
partition (found by its host-assigned GPT partition GUID, disk and byte range)
as exFAT with the system `format` tool, and the application opens that volume
by its volume GUID path, without a drive letter, refusing reparse points.

Linux x86_64 uses AppImage. Extracting with `--appimage-extract` supports
computers without FUSE. The app directory may be read-only; ais state remains
in the user's application-data directory. Packaging does not grant privileges.
The Linux transport still requires its verified root-owned helper, polkit
policy and executable digest pin at the fixed paths in `protocol.rs`.
It never elevates a helper from an AppImage mount or other user-writable path.
Provisioning that installation is pending native integration work.

The cleanup executable is included but not automatically registered.
Retention is session-only until the app can disclose, register and remove
the per-user cleanup component on the target operating system. Closing the
UI cannot be described as enforcing expiry without that component.
