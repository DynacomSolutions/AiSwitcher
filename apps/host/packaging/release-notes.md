Portable ais Host release candidate.

- macOS arm64: Developer ID signed, notarised and stapled application archive.
- Windows x86_64: unsigned portable archive; WebView2 is required.
- Linux x86_64: AppImage, with extraction mode for computers without FUSE.
- SHA256SUMS covers the final archives, AppImage and dependency notices.

The live USB target is x86_64 with Secure Boot disabled.
Read the README's host app guidance for permissions, cleanup components,
credential retention and recovery limits.

This release remains a draft until the fresh-download checks on all three
platforms and the documented native privilege and USB acceptance checks pass.
Do not publish it based on shell or file-image tests alone.
