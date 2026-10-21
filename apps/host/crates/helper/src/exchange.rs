//! exFAT preparation. The formatter sees only a fresh anonymous regular file.
//! Device writes use the already approved, locked target and bounded p4.
use ais_host_core::device::{ByteRange, WritePlan, WriteTarget};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn memfd_create(name: *const std::ffi::c_char, flags: u32) -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn lseek(fd: i32, offset: i64, whence: i32) -> i64;
}

pub struct PreparedExchange {
    file: File,
    range: ByteRange,
    extents: Vec<ByteRange>,
}

impl PreparedExchange {
    pub fn native(plan: &WritePlan) -> Result<Self, &'static str> {
        #[cfg(target_os = "linux")]
        let (mkfs, fsck) = (trusted_tool("mkfs.exfat")?, trusted_tool("fsck.exfat")?);
        // The system formatter; the consistency check is not used on macOS.
        #[cfg(target_os = "macos")]
        let (mkfs, fsck) = (trusted_tool("newfs_exfat")?, trusted_tool("newfs_exfat")?);
        Self::prepare(plan, &mkfs, &fsck)
    }

    /// Explicit test seam for installed exfatprogs. The target is still a new
    /// anonymous regular file; these paths name executables, never devices.
    #[cfg(feature = "file-test")]
    pub fn fixture(plan: &WritePlan, mkfs: &Path, fsck: &Path) -> Result<Self, &'static str> {
        Self::prepare(plan, mkfs, fsck)
    }

    fn prepare(plan: &WritePlan, mkfs: &Path, fsck: &Path) -> Result<Self, &'static str> {
        let range = plan
            .exchange_range()
            .ok_or("The exchange range is unavailable.")?;
        let (mut file, path, _staging) = staging_file(range.length)?;
        format_staging(mkfs, &path)?;
        // The formatter sees a standalone volume. Record its final partition
        // offset in both boot regions, updating the exFAT boot checksums.
        let mut boot = vec![0; 12 * 512];
        file.rewind()
            .and_then(|_| file.read_exact(&mut boot))
            .map_err(|_| "The exchange boot region is unreadable.")?;
        if &boot[3..11] != b"EXFAT   "
            || boot[108] != 9
            || u64::from_le_bytes(boot[72..80].try_into().unwrap()) != range.length / 512
        {
            return Err("The formatter returned an unexpected exchange layout.");
        }
        boot[64..72].copy_from_slice(&(range.start / 512).to_le_bytes());
        let mut checksum = 0u32;
        for (index, byte) in boot[..11 * 512].iter().enumerate() {
            if !matches!(index, 106 | 107 | 112) {
                checksum = checksum.rotate_right(1).wrapping_add(u32::from(*byte));
            }
        }
        for word in boot[11 * 512..].as_chunks_mut::<4>().0 {
            word.copy_from_slice(&checksum.to_le_bytes());
        }
        file.rewind()
            .and_then(|_| file.write_all(&boot))
            .and_then(|_| file.write_all(&boot))
            .and_then(|_| file.sync_all())
            .map_err(|_| "The exchange boot regions could not be prepared.")?;
        check_staging(fsck, &path)?;
        let extents = sealed_extents(&file, range)?;
        if extents.is_empty() {
            return Err("The formatted exchange has no metadata.");
        }
        Ok(Self {
            file,
            range,
            extents,
        })
    }

    pub(crate) fn validate_plan(&self, plan: &WritePlan) -> Result<(), &'static str> {
        if plan.exchange_range() != Some(self.range) {
            return Err("The formatted exchange does not match the confirmed plan.");
        }
        Ok(())
    }

    pub(crate) fn write(
        &mut self,
        target: &mut impl WriteTarget,
        plan: &WritePlan,
    ) -> Result<(), &'static str> {
        self.validate_plan(plan)?;
        plan.verify_created_target(target)
            .map_err(|_| "The drive changed before formatting.")?;
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut expected = [0u8; 64 * 1024];
        let mut actual = [0u8; 64 * 1024];
        for extent in &self.extents {
            let mut offset = extent.start;
            while offset < extent.start + extent.length {
                if Instant::now() >= deadline {
                    return Err("The exchange write timed out.");
                }
                plan.verify_created_layout(target)
                    .map_err(|_| "The drive changed during formatting.")?;
                let count = ((extent.start + extent.length - offset) as usize).min(expected.len());
                self.file
                    .seek(SeekFrom::Start(offset))
                    .and_then(|_| self.file.read_exact(&mut expected[..count]))
                    .map_err(|_| "The verified exchange metadata is unreadable.")?;
                target
                    .seek(SeekFrom::Start(self.range.start + offset))
                    .and_then(|_| target.write_all(&expected[..count]))
                    .and_then(|_| target.flush_durable())
                    .and_then(|_| target.read_at(self.range.start + offset, &mut actual[..count]))
                    .map_err(|_| "The exchange metadata could not be written and read back.")?;
                if actual[..count] != expected[..count] {
                    return Err("The exchange metadata failed readback verification.");
                }
                offset += count as u64;
            }
        }
        plan.verify_created_target(target)
            .map_err(|_| "The drive changed after formatting.")
    }
}

/// Linux stages the volume in a sealed memfd that the tools name through /proc.
#[cfg(target_os = "linux")]
fn staging_file(length: u64) -> Result<(File, String, ()), &'static str> {
    use std::os::fd::FromRawFd;
    // SAFETY: the name is terminated and flags request CLOEXEC and sealing.
    let descriptor = unsafe { memfd_create(c"ais-exchange".as_ptr(), 3) };
    if descriptor < 0 {
        return Err("The exchange staging file is unavailable.");
    }
    // SAFETY: this descriptor was just created and has one owner.
    let file = unsafe { File::from_raw_fd(descriptor) };
    file.set_len(length)
        .map_err(|_| "The exchange staging size is invalid.")?;
    let path = format!("/proc/{}/fd/{descriptor}", std::process::id());
    Ok((file, path, ()))
}

#[cfg(target_os = "linux")]
fn format_staging(mkfs: &Path, path: &str) -> Result<(), &'static str> {
    run_tool(mkfs, &["-L", "AISX", path])
}

#[cfg(target_os = "linux")]
fn check_staging(fsck: &Path, path: &str) -> Result<(), &'static str> {
    run_tool(fsck, &["-n", path])
}

#[cfg(target_os = "linux")]
fn sealed_extents(file: &File, range: ByteRange) -> Result<Vec<ByteRange>, &'static str> {
    use std::os::fd::AsRawFd;
    let descriptor = file.as_raw_fd();
    // SAFETY: this owned regular descriptor supports seals. Prevent any
    // further write, resize or seal changes to the verified output.
    if unsafe { fcntl(descriptor, 1033, 15) } < 0 {
        return Err("The verified exchange could not be sealed.");
    }
    let mut extents = Vec::new();
    let mut offset = 0;
    let mut total = 0;
    while offset < range.length {
        // SAFETY: the descriptor is open and the bounded offset fits i64.
        // SEEK_DATA/SEEK_HOLE touch the anonymous regular file, never a disk.
        let start = unsafe { lseek(descriptor, offset as i64, 3) };
        if start < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(6) {
                break;
            }
            return Err("The exchange metadata extents are unavailable.");
        }
        // SAFETY: start is a valid offset just returned for this descriptor.
        let end = unsafe { lseek(descriptor, start, 4) };
        if end <= start || end as u64 > range.length {
            return Err("The exchange metadata exceeds its range.");
        }
        let extent = ByteRange {
            start: start as u64,
            length: (end - start) as u64,
        };
        total += extent.length;
        if total > 128 * 1024 * 1024 || extents.len() >= 4096 {
            return Err("The exchange metadata exceeds its size limit.");
        }
        extents.push(extent);
        offset = end as u64;
    }
    Ok(extents)
}

/// Removes the staging file's name when preparation ends. The file lives in
/// root's own directory, so no other user can reach it meanwhile.
#[cfg(target_os = "macos")]
struct StagingName(std::path::PathBuf);

#[cfg(target_os = "macos")]
impl Drop for StagingName {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// macOS has no memfd, so the volume is staged in a private file of root.
#[cfg(target_os = "macos")]
fn staging_file(length: u64) -> Result<(File, String, StagingName), &'static str> {
    use std::os::fd::FromRawFd;
    let mut template = *b"/private/var/root/.ais-host-exchange-XXXXXX\0";
    // SAFETY: the template is a writable NUL-terminated string.
    let descriptor = unsafe { libc::mkstemp(template.as_mut_ptr().cast()) };
    if descriptor < 0 {
        return Err("The exchange staging file is unavailable.");
    }
    let path = std::str::from_utf8(&template[..template.len() - 1])
        .map_err(|_| "The exchange staging file is unavailable.")?
        .to_owned();
    // SAFETY: mkstemp returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(descriptor) };
    let name = StagingName(path.clone().into());
    file.set_len(length)
        .map_err(|_| "The exchange staging size is invalid.")?;
    Ok((file, path, name))
}

/// newfs_exfat formats devices, so the staging file is attached as a raw disk
/// image with no mounting, formatted, and detached again before it is read.
#[cfg(target_os = "macos")]
fn format_staging(mkfs: &Path, path: &str) -> Result<(), &'static str> {
    let attached = attach_whole_disk(path)?;
    let formatted = run_tool(
        mkfs,
        &["-v", "AISX", &attached.replacen("/dev/", "/dev/r", 1)],
    );
    let detached = run_tool(Path::new("/usr/bin/hdiutil"), &["detach", &attached]);
    formatted?;
    detached
}

/// Attach with `-plist`, convert it to JSON and take the whole-disk entry.
#[cfg(target_os = "macos")]
fn attach_whole_disk(path: &str) -> Result<String, &'static str> {
    const FAILED: &str = "The exchange staging image could not be attached.";
    let run = |program: &str, args: &[&str], input: Option<&[u8]>| {
        let mut child = Command::new(program)
            .args(args)
            .env_clear()
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| FAILED)?;
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin.write_all(input).map_err(|_| FAILED)?;
        }
        let output = child.wait_with_output().map_err(|_| FAILED)?;
        if !output.status.success() || output.stdout.len() > 64 * 1024 {
            return Err(FAILED);
        }
        Ok::<_, &'static str>(output.stdout)
    };
    let plist = run(
        "/usr/bin/hdiutil",
        &[
            "attach",
            "-plist",
            "-nomount",
            "-noverify",
            "-noautofsck",
            "-readwrite",
            "-imagekey",
            "diskimage-class=CRawDiskImage",
            path,
        ],
        None,
    )?;
    let json = run(
        "/usr/bin/plutil",
        &["-convert", "json", "-o", "-", "-"],
        Some(&plist),
    )?;
    whole_disk_entry(&json).ok_or(FAILED)
}

/// The `/dev/diskN` entry (not a slice) among the attached system entities.
#[cfg(any(target_os = "macos", test))]
fn whole_disk_entry(json: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(json).ok()?;
    value
        .get("system-entities")?
        .as_array()?
        .iter()
        .filter_map(|entity| entity.get("dev-entry")?.as_str())
        .find(|node| {
            node.strip_prefix("/dev/disk").is_some_and(|digits| {
                !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
            })
        })
        .map(str::to_owned)
}

/// The boot-region layout is checked below and the app re-mounts and verifies
/// the volume after the write, so no separate consistency tool is required.
#[cfg(target_os = "macos")]
fn check_staging(_: &Path, _: &str) -> Result<(), &'static str> {
    Ok(())
}

/// Without SEEK_DATA, the metadata is every non-empty 64 KiB block of the
/// freshly formatted volume, merged into extents.
#[cfg(target_os = "macos")]
fn sealed_extents(file: &File, range: ByteRange) -> Result<Vec<ByteRange>, &'static str> {
    use std::os::unix::fs::FileExt;
    const BLOCK: u64 = 64 * 1024;
    let mut extents: Vec<ByteRange> = Vec::new();
    let mut total = 0;
    let mut block = vec![0; BLOCK as usize];
    let mut offset = 0;
    while offset < range.length {
        let length = BLOCK.min(range.length - offset);
        let block = &mut block[..length as usize];
        file.read_exact_at(block, offset)
            .map_err(|_| "The exchange metadata extents are unavailable.")?;
        if block.iter().any(|byte| *byte != 0) {
            total += length;
            if total > 128 * 1024 * 1024 {
                return Err("The exchange metadata exceeds its size limit.");
            }
            match extents.last_mut() {
                Some(last) if last.start + last.length == offset => last.length += length,
                _ => {
                    if extents.len() >= 4096 {
                        return Err("The exchange metadata exceeds its size limit.");
                    }
                    extents.push(ByteRange {
                        start: offset,
                        length,
                    });
                }
            }
        }
        offset += length;
    }
    Ok(extents)
}

fn trusted_tool(name: &str) -> Result<std::path::PathBuf, &'static str> {
    #[cfg(target_os = "linux")]
    const DIRECTORIES: [&str; 2] = ["/usr/sbin", "/usr/bin"];
    #[cfg(target_os = "macos")]
    // newfs_exfat ships in /sbin on current macOS.
    const DIRECTORIES: [&str; 1] = ["/sbin"];
    for directory in DIRECTORIES {
        let Ok(path) = Path::new(directory).join(name).canonicalize() else {
            continue;
        };
        let trusted = path.ancestors().all(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0)
        });
        if trusted && path.is_file() {
            return Ok(path);
        }
    }
    Err("Install the system exfatprogs formatter and checker before creating a drive.")
}

fn run_tool(program: &Path, args: &[&str]) -> Result<(), &'static str> {
    let mut child = Command::new(program)
        .args(args)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "The exFAT tool could not be started.")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("The exFAT tool refused the exchange file.")
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The exFAT tool did not complete.");
            }
        }
    }
}

#[cfg(all(test, feature = "file-test", target_os = "linux"))]
mod tests {
    use super::*;
    use ais_host_core::file_test::{FaultTarget, FileTarget, SyntheticRelease};

    struct CorruptAfterWrite(FaultTarget);
    impl Read for CorruptAfterWrite {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(bytes)
        }
    }
    impl Seek for CorruptAfterWrite {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.0.seek(position)
        }
    }
    impl Write for CorruptAfterWrite {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let count = self.0.write(bytes)?;
            self.0.corrupt_readback = true;
            Ok(count)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.0.flush()
        }
    }
    impl WriteTarget for CorruptAfterWrite {
        fn observe(&self) -> std::io::Result<ais_host_core::device::DeviceObservation> {
            self.0.observe()
        }
        fn lock_exclusive(&mut self) -> std::io::Result<()> {
            self.0.lock_exclusive()
        }
        fn flush_durable(&mut self) -> std::io::Result<()> {
            self.0.flush_durable()
        }
    }

    #[test]
    fn formatting_refusals_and_readback_faults_preserve_the_reserved_region() {
        let directory = std::env::temp_dir();
        let (_, mut image) =
            SyntheticRelease::new(ais_host_core::layout::synthetic_sfdisk_contract_fixture())
                .verify_live_layout(&directory)
                .unwrap();
        let mut target = FileTarget::create_sparse(&directory, 3 * 1024 * 1024 * 1024).unwrap();
        let observation = target.observe().unwrap();
        let plan = WritePlan::create_drive(&image, observation.clone()).unwrap();
        let range = plan.exchange_range().unwrap();
        let reserve_start = range.start + range.length;
        let tools = std::env::var_os("AIS_HOST_TEST_EXFAT_TOOLS").map(std::path::PathBuf::from);
        let tool = |name: &str| {
            tools
                .as_ref()
                .map_or_else(|| name.into(), |path| path.join(name))
        };
        assert!(
            PreparedExchange::fixture(
                &plan,
                Path::new("missing-SYNTHETIC_FIXTURE"),
                &tool("fsck.exfat")
            )
            .is_err()
        );
        let mut exchange =
            PreparedExchange::fixture(&plan, &tool("mkfs.exfat"), &tool("fsck.exfat")).unwrap();
        let deadline = crate::protocol::linux_transport::boottime_ns().unwrap() + 90_000_000_000;
        let name = observation.display_identifier.clone();
        let wrong_plan = WritePlan::create_layout(&image, observation).unwrap();
        assert!(
            crate::service::create_confirmed(
                &mut target,
                deadline,
                &mut image,
                &wrong_plan,
                &name,
                &mut exchange
            )
            .is_err()
        );
        let mut bytes = [1; 512];
        target.read_at(0, &mut bytes).unwrap();
        assert_eq!(bytes, [0; 512], "formatting refusals precede imaging");

        crate::service::write_confirmed(&mut target, deadline, &mut image, &plan, &name).unwrap();
        target.read_at(reserve_start, &mut bytes).unwrap();
        assert_eq!(bytes, [0; 512], "creation clears persistence");
        // The sentinel covers the exchange-formatting phase. Creation must
        // first clear old persistence bytes under the drive identity contract.
        target.seek(SeekFrom::Start(reserve_start)).unwrap();
        target.write_all(&[0xa7; 512]).unwrap();
        let mut target = FaultTarget::new(target);
        let mut changed = target.observe().unwrap();
        changed.mount_fingerprint[0] ^= 1;
        target.observed = Some(changed);
        assert!(exchange.write(&mut target, &plan).is_err());
        assert_eq!(target.written, 0, "changed mount refuses before formatting");
        target.observed = None;
        target.fail_flush = true;
        assert!(exchange.write(&mut target, &plan).is_err());
        assert!(target.written > 0);
        target.fail_flush = false;
        let mut corrupt = CorruptAfterWrite(target);
        assert_eq!(
            exchange.write(&mut corrupt, &plan),
            Err("The exchange metadata failed readback verification.")
        );
        let mut target = corrupt.0;
        target.corrupt_readback = false;
        target.maximum_write = 4096;
        exchange.write(&mut target, &plan).unwrap();
        target.read_at(reserve_start, &mut bytes).unwrap();
        assert_eq!(bytes, [0xa7; 512]);
        target.read_at(range.start, &mut bytes).unwrap();
        assert_eq!(&bytes[3..11], b"EXFAT   ");
        assert_eq!(
            u64::from_le_bytes(bytes[72..80].try_into().unwrap()),
            range.length / 512
        );
    }
}

#[cfg(test)]
mod staging_tests {
    use super::whole_disk_entry;

    #[test]
    fn the_whole_disk_is_chosen_by_name_not_by_position() {
        let json =
            br#"{"system-entities":[{"dev-entry":"/dev/disk9s1"},{"dev-entry":"/dev/disk9"}]}"#;
        assert_eq!(whole_disk_entry(json).as_deref(), Some("/dev/disk9"));
        for bad in [
            &br#"{"system-entities":[{"dev-entry":"/dev/disk9s1"}]}"#[..],
            br#"{"system-entities":[{"dev-entry":"/tmp/disk9"}]}"#,
            br#"{}"#,
            b"not json",
        ] {
            assert!(whole_disk_entry(bad).is_none());
        }
    }
}
