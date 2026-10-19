# Exchange image integration contract

Task 1 must copy the archiso profile into the build profile and additionally
install `image/lib/ais-outbox` as `/usr/local/lib/ais-live/ais-outbox` mode
0755 and the compiled/runtime `ais` command as `/usr/local/bin/ais`. The guest
runtime needs `age`, `keyutils` (`keyctl`), `exfatprogs`, `util-linux` (`flock`),
`nodejs`, `runuser`, `systemd`, and the existing `ais` runtime. No Python or
additional npm package is required by this wrapper.

The exchange services expect Task 3 persistence to have mounted
`/mnt/persist` before the boot flow reaches `ais-live-boot.service`; their
`ConditionPathIsMountPoint=/mnt/persist` skips clean mode without causing a
persist mount. Task 3 must keep the `ais-live-outbox-shutdown.service` stop
action ahead of persist unmount and key revocation. The exchange shutdown
service deliberately does not name an unknown revoke unit. The exchange key
must remain present in the root user keyring through the shutdown writer.

Task 4 must keep `ais-live-inbox.service` before the boot orchestrator and
console. It must retry deferred inboxes after clock synchronisation and route
configuration conflict prompts to the live console before `ais launch`. The
CLI returns exit 2 without a controlling terminal and never prompts from the
root service. The 15-minute inbox timer retries deferred work.

The image enables the mount from `local-fs.target`, the inbox service and
shutdown writer from `multi-user.target`, and both retry/periodic timers from
`timers.target` using the checked-in `.wants` links. The root wrapper only
passes a fully age-authenticated, size-limited tar on stdin to the agent CLI.

## Task 2 QEMU runner interface

`image/test/exchange.exp` is a sourced Expect library, not a VM launcher. The
runner owns QEMU, serial-channel creation, QMP reboot/RTC changes, fixture
staging, and host access to the image. It calls
`ais_exchange::wait_case $serial_channel $case_name` after requesting that
phase from the injected test-only root unit. The guest phase program is
`image/test/exchange-scenarios.sh`; it refuses to run unless `ais.test=1` is
present on the kernel command line and emits a pass marker only after checking
the actual persistent state, configuration, journal, or outbox. The test unit
must be installed only into test images and must not expose a root login.

The runner stages encrypted fixtures with
`AIS_EXCHANGE_TEST_PASSPHRASE=SYNTHETIC_FIXTURE_exchange_passphrase` and
`image/test/exchange-host.sh fixture <kind> <mounted-exchange-root>`. Fixture
kinds are `inbox`, `auth`, `crafted`, and `tamper`. The nine checks map to:

1. `boot`: inbox sequence 1 applies the synthetic settings file.
2. `replay`: reboot and rerun inbox; sequence remains 1 and the CLI reports
   zero applied entries.
3. `tamper`: the flipped-byte sequence 2 bundle is rejected without changing
   the persisted state hash.
4. `periodic`: invoke the outbox timer/service and verify a newly encrypted
   bundle on the host.
5. `exfat-readback`: run `exchange-host.sh exfat-readback <partition-device>
   <bundle-name>`; this calls `fsck.exfat -n`, mounts the exFAT partition
   read-only, checks the bundle, and unmounts it.
6. `symlink`: agent-owned log and directory symlinks are skipped. The runner
   decrypts the outbox with `verify-outbox` and checks manifest hashes against
   tar payload bytes, a synthetic log entry, skipped-symlink count, and absence
   of the external sentinel.
7. `crafted`: fixture sequence 5 carries a symlink and a following write. The
   guest checks the external sentinel hash and inbox state are unchanged.
8. `outbox`: the host's `verify-outbox` also asserts the manifest's
   `lastInboxSeq` equals the last successfully applied fixture sequence.
9. `auth-deferred` / `auth-plausible`: runner boots once with RTC year 2000,
   checks deferral and unchanged state, then sets plausible time and confirms
   sequence 4 applies.

`shutdown` separately stops the shutdown writer and confirms its outbox is
published before VM poweroff. Task 2 still needs to source the Expect library,
add a test-only phase invocation path, and orchestrate these firmware/RTC/host
partition steps. The actual QEMU scenarios have not run yet.
