//! Linux sysfs observation, retained-handle target access and authenticated
//! shared-writer integration. Production use remains disabled until the
//! root-owned package trust record, polkit policy and application sender ship.

use ais_host_core::{device::DeviceObservation, release::sha256};
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    fs::File,
    io,
    path::Path,
};

pub(super) const REASON: &str = "Linux observation, retained target checks and helper-side plan reconstruction are implemented; root-owned package trust, polkit policy packaging and the application request sender are unavailable, so production writes remain disabled.";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinuxDiskSnapshot {
    pub name: String,
    pub major_minor: String,
    /// Kernel disk sequence changes when a device number is reused.
    pub disk_sequence: u64,
    pub size_sectors: u64,
    pub logical_sector_bytes: u32,
    pub removable: bool,
    pub device_syspath: String,
    pub serial: Option<String>,
    pub partitions: Vec<LinuxPartition>,
    pub table_fingerprint: [u8; 32],
    pub mounted_major_minors: Vec<String>,
    pub system_major_minors: Vec<String>,
    pub writable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxPartition {
    pub name: String,
    pub major_minor: String,
    pub start_sectors: u64,
    pub size_sectors: u64,
    pub partition_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinuxDiskObservation {
    pub observation: DeviceObservation,
    pub kernel_name: String,
    pub major_minor: String,
}

/// A retained block-device handle. Construction is only available to code that
/// holds the helper's non-constructible authenticated-channel proof.
pub struct LinuxBlockTarget {
    file: File,
    name: String,
    approved: DeviceObservation,
    retained_inode: u64,
    retained_device: u64,
    retained_rdev: u64,
}

impl LinuxBlockTarget {
    pub fn open_authenticated(
        _channel: &crate::protocol::AuthenticatedChannel,
        approved: &DeviceObservation,
    ) -> Result<Self, ObservationError> {
        approved
            .validate()
            .map_err(|_| ObservationError::Ineligible)?;
        let major_minor = approved
            .os_identity
            .strip_prefix("linux:")
            .ok_or(ObservationError::Ineligible)?;
        if !valid_major_minor(major_minor) {
            return Err(ObservationError::Ineligible);
        }
        let sysfs = fs::canonicalize(Path::new("/sys/dev/block").join(major_minor))
            .map_err(|_| ObservationError::Ineligible)?;
        if sysfs.join("partition").exists() {
            return Err(ObservationError::Ineligible);
        }
        let name = sysfs
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ObservationError::Ineligible)?;
        component(name)?;
        let native = collect_snapshot(name)?;
        if native.major_minor != major_minor {
            return Err(ObservationError::Changed);
        }
        let current = observe(&native)?;
        if current.observation != *approved {
            return Err(ObservationError::Changed);
        }
        let path = Path::new("/dev").join(&native.name);
        use std::os::unix::fs::OpenOptionsExt;
        // Linux values: O_EXCL rejects a mounted/in-use block device, O_NOFOLLOW
        // prevents replacing the final /dev entry with a symlink, O_CLOEXEC
        // prevents leaking the privileged descriptor to children.
        const O_EXCL: i32 = 0x80;
        const O_NOFOLLOW: i32 = 0x20_000;
        const O_CLOEXEC: i32 = 0x80_000;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(O_EXCL | O_NOFOLLOW | O_CLOEXEC)
            .open(&path)
            .map_err(|_| ObservationError::Ineligible)?;
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let metadata = file
            .metadata()
            .map_err(|_| ObservationError::InvalidInput)?;
        if !metadata.file_type().is_block_device()
            || linux_rdev(metadata.rdev()) != native.major_minor
        {
            return Err(ObservationError::Changed);
        }
        let retained_inode = metadata.ino();
        let retained_device = metadata.dev();
        let retained_rdev = metadata.rdev();
        Ok(Self {
            file,
            name: native.name,
            approved: approved.clone(),
            retained_inode,
            retained_device,
            retained_rdev,
        })
    }
}

impl io::Read for LinuxBlockTarget {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        io::Read::read(&mut self.file, buffer)
    }
}
impl io::Write for LinuxBlockTarget {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        io::Write::write(&mut self.file, buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        io::Write::flush(&mut self.file)
    }
}
impl io::Seek for LinuxBlockTarget {
    fn seek(&mut self, position: io::SeekFrom) -> io::Result<u64> {
        io::Seek::seek(&mut self.file, position)
    }
}
impl ais_host_core::device::WriteTarget for LinuxBlockTarget {
    fn observe(&self) -> io::Result<DeviceObservation> {
        use std::os::unix::fs::MetadataExt;
        let metadata = self.file.metadata()?;
        if metadata.ino() != self.retained_inode
            || metadata.dev() != self.retained_device
            || metadata.rdev() != self.retained_rdev
        {
            return Err(io::Error::other("retained device handle changed"));
        }
        let mut snapshot = collect_sysfs_snapshot(&self.name)
            .map_err(|_| io::Error::other("native device recheck failed"))?;
        snapshot.table_fingerprint = read_table_fingerprint(
            &self.file,
            snapshot
                .size_sectors
                .checked_mul(512)
                .ok_or_else(|| io::Error::other("native capacity invalid"))?,
        )
        .map_err(|_| io::Error::other("native table fingerprint failed"))?;
        let current = observe(&snapshot)
            .map(|entry| entry.observation)
            .map_err(|_| io::Error::other("native device recheck failed"))?;
        if current.os_identity != self.approved.os_identity
            || current.connection_identity != self.approved.connection_identity
            || current.capacity_bytes != self.approved.capacity_bytes
            || current.serial != self.approved.serial
        {
            return Err(io::Error::other("native device identity changed"));
        }
        Ok(current)
    }
    fn lock_exclusive(&mut self) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        const LOCK_EX: i32 = 2;
        const LOCK_NB: i32 = 4;
        unsafe extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        // SAFETY: flock operates on this retained, open file descriptor.
        let result = unsafe { flock(self.file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    fn flush_durable(&mut self) -> io::Result<()> {
        self.file.sync_all()
    }
    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        use std::os::unix::fs::FileExt;
        let mut filled = 0;
        while filled < buffer.len() {
            let count = self
                .file
                .read_at(&mut buffer[filled..], offset + filled as u64)?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "short positional read",
                ));
            }
            filled += count;
        }
        Ok(())
    }
}

fn linux_rdev(device: u64) -> String {
    let major = ((device & 0x0000_0000_000f_ff00) >> 8) | ((device & 0xffff_f000_0000_0000) >> 32);
    let minor = (device & 0xff) | ((device & 0x0000_0fff_fff0_0000) >> 12);
    format!("{major}:{minor}")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservationError {
    InvalidInput,
    Changed,
    Ineligible,
}

/// Read one complete, read-only native topology snapshot from sysfs and
/// mountinfo. Partition paths and virtual disks are not accepted as targets.
pub fn collect_snapshot(name: &str) -> Result<LinuxDiskSnapshot, ObservationError> {
    let mut snapshot = collect_sysfs_snapshot(name)?;
    let path = Path::new("/dev").join(name);
    let file = File::open(path).map_err(|_| ObservationError::InvalidInput)?;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let metadata = file
        .metadata()
        .map_err(|_| ObservationError::InvalidInput)?;
    if !metadata.file_type().is_block_device()
        || linux_rdev(metadata.rdev()) != snapshot.major_minor
    {
        return Err(ObservationError::Changed);
    }
    snapshot.table_fingerprint = read_table_fingerprint(
        &file,
        snapshot
            .size_sectors
            .checked_mul(512)
            .ok_or(ObservationError::InvalidInput)?,
    )?;
    Ok(snapshot)
}

/// Discover one full-disk target from its native major/minor identity. The
/// helper derives the kernel name from sysfs and never accepts a client path.
pub fn collect_by_identity(identity: &str) -> Result<LinuxDiskObservation, ObservationError> {
    let major_minor = identity
        .strip_prefix("linux:")
        .ok_or(ObservationError::Ineligible)?;
    if !valid_major_minor(major_minor) {
        return Err(ObservationError::Ineligible);
    }
    let sysfs = fs::canonicalize(Path::new("/sys/dev/block").join(major_minor))
        .map_err(|_| ObservationError::Changed)?;
    if sysfs.join("partition").exists() {
        return Err(ObservationError::Ineligible);
    }
    let name = sysfs
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(ObservationError::InvalidInput)?;
    let snapshot = collect_snapshot(name)?;
    if snapshot.major_minor != major_minor {
        return Err(ObservationError::Changed);
    }
    observe(&snapshot)
}

fn collect_sysfs_snapshot(name: &str) -> Result<LinuxDiskSnapshot, ObservationError> {
    component(name)?;
    let class = Path::new("/sys/class/block").join(name);
    if class.join("partition").exists() {
        return Err(ObservationError::Ineligible);
    }
    let device_syspath = fs::canonicalize(class.join("device"))
        .map_err(|_| ObservationError::InvalidInput)?
        .to_string_lossy()
        .into_owned();
    let read = |path: &Path| {
        fs::read_to_string(path)
            .map(|s| s.trim().to_owned())
            .map_err(|_| ObservationError::InvalidInput)
    };
    let major_minor = read(&class.join("dev"))?;
    let disk_sequence = read(&class.join("diskseq"))?
        .parse()
        .map_err(|_| ObservationError::InvalidInput)?;
    if disk_sequence == 0 {
        return Err(ObservationError::InvalidInput);
    }
    let size_sectors = read(&class.join("size"))?
        .parse()
        .map_err(|_| ObservationError::InvalidInput)?;
    let removable = match read(&class.join("removable"))?.as_str() {
        "0" => false,
        "1" => true,
        _ => return Err(ObservationError::InvalidInput),
    };
    let logical_sector_bytes = read(&class.join("queue/logical_block_size"))?
        .parse()
        .map_err(|_| ObservationError::InvalidInput)?;
    let serial = fs::read_to_string(class.join("device/serial"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let mut partitions = Vec::new();
    for entry in fs::read_dir("/sys/class/block").map_err(|_| ObservationError::InvalidInput)? {
        let entry = entry.map_err(|_| ObservationError::InvalidInput)?;
        let partition_class = entry.path();
        if !partition_class.join("partition").exists() {
            continue;
        }
        let parent = fs::canonicalize(partition_class.join(".."))
            .map_err(|_| ObservationError::InvalidInput)?;
        let target = fs::canonicalize(&class).map_err(|_| ObservationError::InvalidInput)?;
        if parent != target {
            continue;
        }
        let part_name = entry.file_name().to_string_lossy().into_owned();
        partitions.push(LinuxPartition {
            name: component(&part_name)?.to_owned(),
            major_minor: read(&partition_class.join("dev"))?,
            start_sectors: read(&partition_class.join("start"))?
                .parse()
                .map_err(|_| ObservationError::InvalidInput)?,
            size_sectors: read(&partition_class.join("size"))?
                .parse()
                .map_err(|_| ObservationError::InvalidInput)?,
            partition_type: None,
        });
    }
    partitions.sort();

    let mountinfo =
        fs::read_to_string("/proc/self/mountinfo").map_err(|_| ObservationError::InvalidInput)?;
    let mut mounted = BTreeSet::new();
    let mut system_roots = BTreeSet::new();
    for line in mountinfo.lines() {
        let fields = line.split(' ').collect::<Vec<_>>();
        if fields.len() < 10 || !valid_major_minor(fields[2]) {
            return Err(ObservationError::InvalidInput);
        }
        let is_system_mount = matches!(fields[4], "/" | "/boot" | "/boot/efi");
        let separator = fields
            .iter()
            .position(|field| *field == "-")
            .ok_or(ObservationError::InvalidInput)?;
        let fs_type = fields
            .get(separator + 1)
            .ok_or(ObservationError::InvalidInput)?;
        let major = fields[2]
            .split_once(':')
            .ok_or(ObservationError::InvalidInput)?
            .0;
        if major == "0" {
            if is_known_pseudo_filesystem(fs_type) {
                if is_system_mount {
                    return Err(ObservationError::InvalidInput);
                }
                continue;
            }
            return Err(ObservationError::InvalidInput);
        }
        mounted.insert(fields[2].to_owned());
        if is_system_mount {
            system_roots.insert(fields[2].to_owned());
        }
    }
    // Traverse stacked block devices in both directions so backing disks and
    // holders of root/boot devices are all treated as system storage.
    let system = expand_device_graph(system_roots)?;
    let mounted = expand_device_graph(mounted)?;
    // If sysfs says the disk is read-only, fail closed. This is not an attempt
    // to open or probe the block device.
    let writable = match read(&class.join("ro"))?.as_str() {
        "0" => true,
        "1" => false,
        _ => return Err(ObservationError::InvalidInput),
    };
    Ok(LinuxDiskSnapshot {
        name: name.to_owned(),
        major_minor,
        disk_sequence,
        size_sectors,
        logical_sector_bytes,
        removable,
        device_syspath,
        serial,
        partitions,
        table_fingerprint: [0; 32],
        mounted_major_minors: mounted.into_iter().collect(),
        system_major_minors: system.into_iter().collect(),
        writable,
    })
}

fn expand_device_graph(roots: BTreeSet<String>) -> Result<BTreeSet<String>, ObservationError> {
    let mut found = roots;
    let mut queue = found.iter().cloned().collect::<VecDeque<_>>();
    while let Some(dev) = queue.pop_front() {
        let link = Path::new("/sys/dev/block").join(&dev);
        let base = fs::canonicalize(&link).map_err(|_| ObservationError::InvalidInput)?;
        let is_partition = base.join("partition").exists();
        let mut relation_base = base.clone();
        if is_partition {
            relation_base = base
                .parent()
                .ok_or(ObservationError::InvalidInput)?
                .to_path_buf();
            let parent_dev = fs::read_to_string(relation_base.join("dev"))
                .map_err(|_| ObservationError::InvalidInput)?
                .trim()
                .to_owned();
            if !valid_major_minor(&parent_dev) {
                return Err(ObservationError::InvalidInput);
            }
            if found.insert(parent_dev.clone()) {
                queue.push_back(parent_dev);
            }
        }
        for relation in ["slaves", "holders"] {
            let dir = relation_base.join(relation);
            if !dir.is_dir() {
                if is_partition {
                    continue;
                }
                return Err(ObservationError::InvalidInput);
            }
            for entry in fs::read_dir(dir).map_err(|_| ObservationError::InvalidInput)? {
                let peer = entry.map_err(|_| ObservationError::InvalidInput)?;
                let peer_dev = fs::read_to_string(peer.path().join("dev"))
                    .map_err(|_| ObservationError::InvalidInput)?
                    .trim()
                    .to_owned();
                if !valid_major_minor(&peer_dev) {
                    return Err(ObservationError::InvalidInput);
                }
                if found.insert(peer_dev.clone()) {
                    queue.push_back(peer_dev);
                }
            }
        }
    }
    Ok(found)
}

fn is_known_pseudo_filesystem(fs_type: &str) -> bool {
    matches!(
        fs_type,
        "autofs"
            | "bpf"
            | "cgroup"
            | "cgroup2"
            | "configfs"
            | "debugfs"
            | "overlay"
            | "devpts"
            | "devtmpfs"
            | "fusectl"
            | "mqueue"
            | "proc"
            | "pstore"
            | "securityfs"
            | "sysfs"
            | "tmpfs"
            | "tracefs"
    )
}

fn read_table_fingerprint(file: &File, capacity_bytes: u64) -> Result<[u8; 32], ObservationError> {
    use std::os::unix::fs::FileExt;
    const WINDOW: usize = 34 * 512;
    if capacity_bytes < (WINDOW * 2) as u64 {
        return Err(ObservationError::InvalidInput);
    }
    let mut head = vec![0; WINDOW];
    let mut tail = vec![0; WINDOW];
    let read_region = |offset: u64, output: &mut [u8]| -> Result<(), ObservationError> {
        let mut filled = 0;
        while filled < output.len() {
            let count = file
                .read_at(&mut output[filled..], offset + filled as u64)
                .map_err(|_| ObservationError::InvalidInput)?;
            if count == 0 {
                return Err(ObservationError::InvalidInput);
            }
            filled += count;
        }
        Ok(())
    };
    read_region(0, &mut head)?;
    read_region(capacity_bytes - WINDOW as u64, &mut tail)?;
    let mut bytes = head;
    bytes.extend_from_slice(&tail);
    Ok(sha256(&bytes))
}

#[cfg_attr(not(feature = "file-test"), allow(dead_code))] // exercised by fixtures
fn parse_hex_32(value: &str) -> Result<[u8; 32], ObservationError> {
    if value.len() != 64 {
        return Err(ObservationError::InvalidInput);
    }
    let mut output = [0; 32];
    for (index, chunk) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| ObservationError::InvalidInput)?;
        output[index] = u8::from_str_radix(pair, 16).map_err(|_| ObservationError::InvalidInput)?;
    }
    Ok(output)
}

/// Bounded strict parser for testable snapshots collected from sysfs and mountinfo.
/// Duplicate, malformed and unknown keys are rejected instead of guessed.
#[cfg_attr(not(feature = "file-test"), allow(dead_code))] // exercised by fixtures
pub fn parse_snapshot(input: &str) -> Result<LinuxDiskSnapshot, ObservationError> {
    if input.is_empty() || input.len() > 64 * 1024 {
        return Err(ObservationError::InvalidInput);
    }
    let mut fields = std::collections::BTreeMap::new();
    for line in input.lines() {
        let (key, value) = line.split_once('=').ok_or(ObservationError::InvalidInput)?;
        if !matches!(
            key,
            "name"
                | "majorMinor"
                | "diskSequence"
                | "sizeSectors"
                | "logicalSectorBytes"
                | "removable"
                | "deviceSyspath"
                | "serial"
                | "partitions"
                | "tableFingerprint"
                | "mountedMajorMinors"
                | "systemMajorMinors"
                | "writable"
        ) || key.is_empty()
            || value.is_empty()
            || fields.insert(key, value).is_some()
        {
            return Err(ObservationError::InvalidInput);
        }
    }
    let get = |name: &str| {
        fields
            .get(name)
            .copied()
            .ok_or(ObservationError::InvalidInput)
    };
    let number = |name: &str| {
        get(name)?
            .parse::<u64>()
            .map_err(|_| ObservationError::InvalidInput)
    };
    let boolean = |name: &str| match get(name)? {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(ObservationError::InvalidInput),
    };
    let table_fingerprint = parse_hex_32(get("tableFingerprint")?)?;
    let disk_size = number("sizeSectors")?;
    let disk_major_minor = get("majorMinor")?;
    let partitions = match get("partitions")? {
        "-" => Vec::new(),
        raw => {
            let mut values = Vec::new();
            for entry in raw.split(';') {
                if values.len() >= 256 {
                    return Err(ObservationError::InvalidInput);
                }
                let parts = entry.split(',').collect::<Vec<_>>();
                if !(4..=5).contains(&parts.len()) {
                    return Err(ObservationError::InvalidInput);
                }
                let name = component(parts[0])?.to_owned();
                if !valid_major_minor(parts[1]) {
                    return Err(ObservationError::InvalidInput);
                }
                let start_sectors = parts[2]
                    .parse::<u64>()
                    .map_err(|_| ObservationError::InvalidInput)?;
                let size_sectors = parts[3]
                    .parse::<u64>()
                    .map_err(|_| ObservationError::InvalidInput)?;
                if size_sectors == 0
                    || start_sectors.checked_add(size_sectors).is_none()
                    || start_sectors + size_sectors > disk_size
                    || parts[1] == disk_major_minor
                    || values
                        .iter()
                        .any(|p: &LinuxPartition| p.major_minor == parts[1])
                    || values.iter().any(|p: &LinuxPartition| p.name == name)
                {
                    return Err(ObservationError::InvalidInput);
                }
                values.push(LinuxPartition {
                    name,
                    major_minor: parts[1].to_owned(),
                    start_sectors,
                    size_sectors,
                    partition_type: parts.get(4).map(|s| (*s).to_owned()),
                });
            }
            values.sort();
            if values
                .windows(2)
                .any(|pair| pair[0].start_sectors + pair[0].size_sectors > pair[1].start_sectors)
            {
                return Err(ObservationError::InvalidInput);
            }
            values
        }
    };
    let major_minors = |name: &str| -> Result<Vec<String>, ObservationError> {
        let raw = get(name)?;
        if raw == "-" {
            return Ok(Vec::new());
        }
        let values = raw.split(',').map(str::to_owned).collect::<Vec<_>>();
        if values.iter().any(|v| !valid_major_minor(v)) {
            return Err(ObservationError::InvalidInput);
        }
        let mut unique = values.clone();
        unique.sort();
        unique.dedup();
        if unique.len() != values.len() {
            return Err(ObservationError::InvalidInput);
        }
        Ok(unique)
    };
    let serial = match get("serial")? {
        "-" => None,
        value if value.len() <= 256 && !value.chars().any(char::is_control) => {
            Some(value.to_owned())
        }
        _ => return Err(ObservationError::InvalidInput),
    };
    let snapshot = LinuxDiskSnapshot {
        name: component(get("name")?)?.to_owned(),
        major_minor: get("majorMinor")?.to_owned(),
        disk_sequence: get("diskSequence")?
            .parse()
            .map_err(|_| ObservationError::InvalidInput)?,
        size_sectors: disk_size,
        logical_sector_bytes: get("logicalSectorBytes")?
            .parse()
            .map_err(|_| ObservationError::InvalidInput)?,
        removable: boolean("removable")?,
        device_syspath: get("deviceSyspath")?.to_owned(),
        serial,
        partitions,
        table_fingerprint,
        mounted_major_minors: major_minors("mountedMajorMinors")?,
        system_major_minors: major_minors("systemMajorMinors")?,
        writable: boolean("writable")?,
    };
    if !valid_major_minor(&snapshot.major_minor)
        || snapshot.size_sectors == 0
        || snapshot.disk_sequence == 0
        || !matches!(snapshot.logical_sector_bytes, 512 | 4096)
        || !snapshot.device_syspath.starts_with("/sys/devices/")
        || snapshot.device_syspath.split('/').any(|part| part == "..")
        || snapshot.device_syspath.len() > 4096
    {
        return Err(ObservationError::InvalidInput);
    }
    Ok(snapshot)
}

/// A sysfs-visible whole disk worth considering. Virtual, optical and RAM
/// devices never carry a removable USB ancestry, so they are skipped early.
fn is_candidate_disk_name(name: &str) -> bool {
    !["loop", "ram", "zram", "dm-", "md", "sr", "nbd", "fd"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Unprivileged enumeration for the device selector. Only removable USB disks
/// that are writable, unmounted and not backing system storage are returned,
/// with the vendor model string for display. Anything that fails observation is
/// omitted rather than guessed.
pub fn list_eligible() -> Vec<(LinuxDiskObservation, Option<String>)> {
    let Ok(entries) = fs::read_dir("/sys/block") else {
        return Vec::new();
    };
    let mut found = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_candidate_disk_name(&name) {
                return None;
            }
            let snapshot = collect_snapshot(&name).ok()?;
            let observed = observe(&snapshot).ok()?;
            let eligible = observed.observation.external_usb
                && !observed.observation.system_backing
                && observed.observation.writable;
            let model =
                fs::read_to_string(Path::new("/sys/block").join(&name).join("device/model"))
                    .ok()
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty());
            eligible.then_some((observed, model))
        })
        .collect::<Vec<_>>();
    found.sort_by(|a, b| a.0.kernel_name.cmp(&b.0.kernel_name));
    found
}

/// Converts a complete topology snapshot into the core observation format.
/// USB ancestry and removable status must both be present for eligibility.
pub fn observe(snapshot: &LinuxDiskSnapshot) -> Result<LinuxDiskObservation, ObservationError> {
    let usb_path = snapshot.device_syspath.to_ascii_lowercase();
    let external_usb =
        snapshot.removable && usb_path.split('/').any(|part| part.starts_with("usb"));
    let partition_dev_ids = snapshot
        .partitions
        .iter()
        .map(|p| p.major_minor.as_str())
        .collect::<Vec<_>>();
    let system_backing = snapshot
        .system_major_minors
        .iter()
        .any(|id| id == &snapshot.major_minor || partition_dev_ids.contains(&id.as_str()));
    let mounted = snapshot
        .mounted_major_minors
        .iter()
        .any(|id| id == &snapshot.major_minor || partition_dev_ids.contains(&id.as_str()));
    // Linux sysfs `size`, partition `start` and partition `size` are expressed
    // in 512-byte sectors, including on devices with 4 KiB logical sectors.
    let capacity_bytes = snapshot
        .size_sectors
        .checked_mul(512)
        .ok_or(ObservationError::InvalidInput)?;
    let mut ancestry = snapshot.device_syspath.as_bytes().to_vec();
    ancestry.extend_from_slice(&snapshot.disk_sequence.to_be_bytes());
    let mounts = snapshot.mounted_major_minors.join("\n");
    let observation = DeviceObservation {
        os_identity: format!("linux:{}", snapshot.major_minor),
        connection_identity: hex(&sha256(&ancestry)),
        display_identifier: format!("{} ({capacity_bytes} bytes)", snapshot.name),
        serial: snapshot.serial.clone(),
        capacity_bytes,
        sector_bytes: snapshot.logical_sector_bytes,
        table_fingerprint: snapshot.table_fingerprint,
        ancestry_fingerprint: sha256(&ancestry),
        mount_fingerprint: sha256(mounts.as_bytes()),
        external_usb,
        internal: !external_usb,
        system_backing,
        ancestry_complete: !snapshot.device_syspath.is_empty(),
        writable: snapshot.writable && !mounted,
    };
    observation
        .validate()
        .map_err(|_| ObservationError::Ineligible)?;
    Ok(LinuxDiskObservation {
        observation,
        kernel_name: snapshot.name.clone(),
        major_minor: snapshot.major_minor.clone(),
    })
}

/// Recompute all approved identity and topology fields immediately before use.
#[cfg_attr(not(feature = "file-test"), allow(dead_code))] // exercised by fixtures
pub fn recheck(
    approved: &LinuxDiskObservation,
    current: &LinuxDiskSnapshot,
) -> Result<(), ObservationError> {
    if approved == &observe(current)? {
        Ok(())
    } else {
        Err(ObservationError::Changed)
    }
}

fn component(value: &str) -> Result<&str, ObservationError> {
    if value.is_empty()
        || value.len() > 256
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "._-".contains(c)))
    {
        return Err(ObservationError::InvalidInput);
    }
    Ok(value)
}
fn valid_major_minor(value: &str) -> bool {
    value
        .split_once(':')
        .is_some_and(|(a, b)| a.parse::<u32>().is_ok() && b.parse::<u32>().is_ok())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_names_skip_virtual_and_optical_disks() {
        for name in [
            "loop0", "ram1", "zram0", "dm-3", "md127", "sr0", "nbd0", "fd0",
        ] {
            assert!(!is_candidate_disk_name(name), "{name}");
        }
        for name in ["sda", "nvme0n1", "mmcblk0"] {
            assert!(is_candidate_disk_name(name), "{name}");
        }
    }

    const USB: &str = "name=sdx\nmajorMinor=8:16\ndiskSequence=7\nsizeSectors=4000000\nlogicalSectorBytes=512\nremovable=1\ndeviceSyspath=/sys/devices/usb/SYNTHETIC_FIXTURE_DEVICE/block/sdx\nserial=SYNTHETIC_FIXTURE_DISK_01\npartitions=sdx1,8:17,2048,100000,efi;sdx2,8:18,102048,3897952,linux\ntableFingerprint=0000000000000000000000000000000000000000000000000000000000000000\nmountedMajorMinors=-\nsystemMajorMinors=-\nwritable=1";

    #[test]
    fn parses_usb_and_rechecks_complete_observation() {
        let before = observe(&parse_snapshot(USB).unwrap()).unwrap();
        assert!(before.observation.external_usb);
        assert!(!before.observation.internal);
        assert_eq!(before.observation.capacity_bytes, 2_048_000_000);
        assert!(recheck(&before, &parse_snapshot(USB).unwrap()).is_ok());
        let changed = USB.replace("sizeSectors=4000000", "sizeSectors=4000001");
        assert_eq!(
            recheck(&before, &parse_snapshot(&changed).unwrap()),
            Err(ObservationError::Changed)
        );
        let reused = USB.replace("diskSequence=7", "diskSequence=8");
        assert_eq!(
            recheck(&before, &parse_snapshot(&reused).unwrap()),
            Err(ObservationError::Changed)
        );
        let changed_table = USB.replace(
            "tableFingerprint=0000000000000000000000000000000000000000000000000000000000000000",
            "tableFingerprint=0000000000000000000000000000000000000000000000000000000000000001",
        );
        assert_eq!(
            recheck(&before, &parse_snapshot(&changed_table).unwrap()),
            Err(ObservationError::Changed)
        );
    }

    #[test]
    fn rejects_internal_mounted_and_system_backing_devices() {
        let mut snapshot = parse_snapshot(USB).unwrap();
        snapshot.device_syspath = "/sys/devices/pci0000:00/ata1/host0/block/sdx".into();
        snapshot.removable = false;
        assert_eq!(observe(&snapshot), Err(ObservationError::Ineligible));
        let mut snapshot = parse_snapshot(USB).unwrap();
        snapshot.mounted_major_minors.push("8:17".into());
        assert_eq!(observe(&snapshot), Err(ObservationError::Ineligible));
        let mut snapshot = parse_snapshot(USB).unwrap();
        snapshot.system_major_minors.push("8:16".into());
        assert_eq!(observe(&snapshot), Err(ObservationError::Ineligible));
    }

    #[test]
    fn malformed_duplicate_and_unknown_snapshot_fields_are_rejected() {
        assert_eq!(
            parse_snapshot("name=sdx\nname=sdy"),
            Err(ObservationError::InvalidInput)
        );
        assert!(
            parse_snapshot(&USB.replace(
                "deviceSyspath=/sys/devices/",
                "deviceSyspath=/sys/devices/../"
            ))
            .is_err()
        );
        assert!(parse_snapshot(&USB.replace("writable=1", "writable=1\npath=/dev/sda")).is_err());
        assert!(
            parse_snapshot(&USB.replace(
                "partitions=sdx1,8:17,2048,100000,efi;sdx2",
                "partitions=sdx1,8:17,2048,100000,efi;sdx1"
            ))
            .is_err()
        );
    }
}
