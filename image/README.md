# ais live image

The Arch live image is built by `image/build/build.sh`, on a GitHub-hosted
runner, without any container runtime.

- `pins.env`: Arch Linux Archive date, bootstrap tarball name, URL and sha256.
  The tarball is checked before extraction. Moving a pin is a deliberate commit.
- `build/bootstrap.sh`: extracts the pinned Arch bootstrap tarball and points
  pacman at the dated archive.
- `build/build.sh`: bind-mounts `proc`, `sys`, `dev`, enters the root with
  `chroot`, installs `archiso`, runs `mkarchiso` on `archiso/` and writes
  `out/archiso.iso` and `out/build-info.json` (package list and `base-id`).
- `archiso/`: profile derived from archiso `baseline`, boot modes
  `bios.syslinux` and `uefi.grub`. Disk and rescue tools are not preinstalled.
- `build/affected.ts`: decides whether a pull request needs the image build.
- `build/assert-disk.sh`, `build/assert-eltorito.sh`: CI asserts (peak disk
  under 80% of free; both BIOS and EFI El Torito records).

Local use needs root (chroot, mounts), so the build is exercised in CI only.

## Measurements (standard GitHub-hosted runner)

| Item | Value |
| --- | --- |
| Runner disk at job start (`/`) | 145 GB size, 86 GB free (`df -h`) |
| Free before the build | 85.2 GiB (89 378 688 KiB, synchronous first sample) |
| Peak disk growth, build plus raw image assembly | 8.68 GiB (9 101 324 KiB), 10.2% of free |
| Free after the ISO build (before assembly) | 79.8 GiB (83 675 948 KiB) |
| `build.sh` wall time | 333 s (bootstrap 13 s, archiso install 10 s, package install and `mkarchiso` about 5 min) |
| Whole build job | 6 min 17 s including the artifact upload |
| ISO size | 903 163 904 bytes (862 MiB) |

The runner has far more free disk than the 14 GB the plan assumed, so no
preinstalled toolchains are removed. The earlier 3.75 GiB figure came from a
sampler that missed the peak and excluded assembly; the figure above uses
synchronous first and last samples and covers the assembly work files. It
would not fit in 14 GB with margin (about 62% of it).
