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
| Runner disk at job start (`/`) | 145 GiB size, 86 GiB free (`df -h`, rounded) |
| Free before the build | 85.24 GiB (89,378,688 KiB, synchronous first sample) |
| Peak disk growth, build plus raw image assembly | 8.68 GiB (9,101,324 KiB), 10.2% of free |
| Free after the ISO build (before assembly) | 79.80 GiB (83,675,948 KiB) |
| `build.sh` wall time | 333 s (bootstrap 13 s, archiso install 10 s, package install and `mkarchiso` about 5 min) |
| Whole build job | 6 min 17 s including the artifact upload |
| ISO size | 903 163 904 bytes (862 MiB) |

The runner has far more free disk than the plan's 14 GB budget, so no
preinstalled toolchains are removed. The earlier 3.75 GiB figure came from a
sampler that missed the peak and excluded assembly; the figure above uses
synchronous first and last samples and covers the assembly work files. The
measured 9,101,324 KiB peak is 10.2% of the measured initial free space and
66.57% of a 14 GB budget (13,671,875 KiB), below the 80% assertion threshold
of 10,937,500 KiB. This leaves 1,836,176 KiB (about 1.75 GiB) before reaching
the threshold.

## Live image notes

### Non-interactive age passphrases

The exchange services use age's batchpass plugin mode. Require age 1.3 or
newer; Task 1 owns the archive pin and must keep it at or above that minimum.
The verified CLI version is age 1.3.2. The passphrase is supplied through
file descriptor 3 with `AGE_PASSPHRASE_FD=3`, and inherited
`AGE_PASSPHRASE` and `AGE_PASSPHRASE_WORK_FACTOR` variables are unset. For
example, the service opens descriptor 3 on the root keyring payload and runs:

```sh
exec 3< <(keyctl pipe "$key_id" || exit; printf '\n')
env -u AGE_PASSPHRASE -u AGE_PASSPHRASE_WORK_FACTOR \
  AGE_PASSPHRASE_FD=3 age -e -j batchpass <bundle.tar >bundle.age
exec 3<&-
```

Decryption uses the same descriptor contract with `age -d -j batchpass`.
Both operations work without a controlling terminal. Do not put the
passphrase in an argument, environment value, or temporary file. The default
scrypt stanza interoperates with Rust age 0.11.5.
