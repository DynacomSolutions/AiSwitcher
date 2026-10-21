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

Windows x86_64 uses a portable ZIP with adjacent executables and resource
files. Windows signing is deferred. WebView2 must already be available.
Listing USB drives needs no elevation. The helper starts elevated through UAC
(`runas`) only when a preview or write begins, and only from the executable
next to the application. It creates a named pipe whose DACL admits the
launching user's SID alone (first instance, no remote clients) and accepts one
client: the process whose image is the application beside it, rechecked before
each volume is locked. It takes a disk number, never a path, and re-validates
the disk itself. Creating and updating drives stay unavailable on Windows
because the exFAT exchange partition cannot yet be opened there.

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
