//! macOS disk observation and retained raw-device handle.
//!
//! The raw device is only opened by the root helper, after the authenticated
//! channel has pinned the application and the helper has re-resolved the disk
//! from its identity. Mount state is deliberately not part of the observed
//! identity: macOS mounts every volume, and the helper unmounts the whole disk
//! itself before it opens the device.

// The file-test build compiles this module on Linux for its parsing tests only.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(target_os = "macos")]
use ais_host_core::device::WriteTarget;
use ais_host_core::{device::DeviceObservation, release::sha256};
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::io::{self, Read, SeekFrom, Write};
#[cfg(target_os = "macos")]
use std::{
    fs::{File, OpenOptions},
    os::unix::{
        fs::{FileExt, FileTypeExt, OpenOptionsExt},
        io::AsRawFd,
    },
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub(super) const REASON: &str = "macOS writes need the bundled helper next to the signed application and an administrator authorisation.";

const MAX_PLIST_BYTES: usize = 1024 * 1024;
const MAX_PARTITIONS: usize = 256;
#[cfg(target_os = "macos")]
const TABLE_WINDOW_BYTES: usize = 34 * 512;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacDiskSnapshot {
    pub identifier: String,
    pub device_node: String,
    pub capacity_bytes: u64,
    pub connection_generation: u64,
    pub ancestry_complete: bool,
    pub sector_bytes: u32,
    pub internal: bool,
    pub removable: bool,
    pub protocol: String,
    pub serial: Option<String>,
    pub device_tree_path: String,
    pub writable: bool,
    pub partitions: Vec<MacPartition>,
    pub system_backing: bool,
    pub table_fingerprint: [u8; 32],
    pub ancestry_fingerprint: [u8; 32],
    pub mount_fingerprint: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct MacPartition {
    pub identifier: String,
    pub mounted: bool,
    pub mount_point: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacDiskObservation {
    pub observation: DeviceObservation,
    pub identifier: String,
    pub device_node: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservationError {
    InvalidInput,
    Changed,
    Ineligible,
    NativeUnavailable,
}

/// Strict, synthetic snapshot parser used by CI. Values contain no live host
/// identifiers. Unknown, duplicated, malformed and missing fields fail closed.
#[cfg_attr(not(feature = "file-test"), allow(dead_code))] // exercised by fixtures
pub fn parse_snapshot(input: &str) -> Result<MacDiskSnapshot, ObservationError> {
    if input.is_empty() || input.len() > MAX_PLIST_BYTES {
        return Err(ObservationError::InvalidInput);
    }
    let mut fields = std::collections::BTreeMap::new();
    for line in input.lines() {
        let (key, value) = line.split_once('=').ok_or(ObservationError::InvalidInput)?;
        if !matches!(
            key,
            "identifier"
                | "deviceNode"
                | "capacityBytes"
                | "connectionGeneration"
                | "ancestryComplete"
                | "sectorBytes"
                | "internal"
                | "removable"
                | "protocol"
                | "serial"
                | "deviceTreePath"
                | "writable"
                | "partitions"
                | "systemBacking"
                | "tableFingerprint"
                | "ancestryFingerprint"
                | "mountFingerprint"
        ) || value.is_empty()
            || fields.insert(key, value).is_some()
        {
            return Err(ObservationError::InvalidInput);
        }
    }
    let get = |key: &str| {
        fields
            .get(key)
            .copied()
            .ok_or(ObservationError::InvalidInput)
    };
    let boolean = |key: &str| match get(key)? {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(ObservationError::InvalidInput),
    };
    let digest = |key: &str| -> Result<[u8; 32], ObservationError> {
        let raw = get(key)?;
        if raw.len() != 64 {
            return Err(ObservationError::InvalidInput);
        }
        let mut out = [0; 32];
        for (idx, pair) in raw.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let high = hex(pair[0]).ok_or(ObservationError::InvalidInput)?;
            let low = hex(pair[1]).ok_or(ObservationError::InvalidInput)?;
            out[idx] = (high << 4) | low;
        }
        Ok(out)
    };
    let identifier = get("identifier")?.to_owned();
    let device_node = get("deviceNode")?.to_owned();
    validate_identifier(&identifier)?;
    if device_node != format!("/dev/{identifier}") {
        return Err(ObservationError::InvalidInput);
    }
    let capacity_bytes = get("capacityBytes")?
        .parse()
        .map_err(|_| ObservationError::InvalidInput)?;
    let connection_generation = get("connectionGeneration")?
        .parse()
        .map_err(|_| ObservationError::InvalidInput)?;
    let sector_bytes: u32 = get("sectorBytes")?
        .parse()
        .map_err(|_| ObservationError::InvalidInput)?;
    let mut partitions = Vec::new();
    if get("partitions")? != "-" {
        for item in get("partitions")?.split(';') {
            let bits = item.split(',').collect::<Vec<_>>();
            if bits.len() != 3 || partitions.len() == MAX_PARTITIONS {
                return Err(ObservationError::InvalidInput);
            }
            validate_partition_identifier(&identifier, bits[0])?;
            let mounted = match bits[1] {
                "true" => true,
                "false" => false,
                _ => return Err(ObservationError::InvalidInput),
            };
            let mount_point = if bits[2] == "-" {
                None
            } else {
                Some(bits[2].to_owned())
            };
            if mount_point
                .as_ref()
                .is_some_and(|path| !path.starts_with('/') || path.chars().any(char::is_control))
            {
                return Err(ObservationError::InvalidInput);
            }
            if mounted != mount_point.is_some() {
                return Err(ObservationError::InvalidInput);
            }
            partitions.push(MacPartition {
                identifier: bits[0].to_owned(),
                mounted,
                mount_point,
            });
        }
    }
    partitions.sort();
    if partitions
        .windows(2)
        .any(|pair| pair[0].identifier == pair[1].identifier)
    {
        return Err(ObservationError::InvalidInput);
    }
    let serial = match get("serial")? {
        "-" => None,
        value if value.len() <= 256 && !value.chars().any(char::is_control) => {
            Some(value.to_owned())
        }
        _ => return Err(ObservationError::InvalidInput),
    };
    let snapshot = MacDiskSnapshot {
        identifier,
        device_node,
        capacity_bytes,
        connection_generation,
        ancestry_complete: boolean("ancestryComplete")?,
        sector_bytes,
        internal: boolean("internal")?,
        removable: boolean("removable")?,
        protocol: get("protocol")?.to_owned(),
        serial,
        device_tree_path: get("deviceTreePath")?.to_owned(),
        writable: boolean("writable")?,
        partitions,
        system_backing: boolean("systemBacking")?,
        table_fingerprint: digest("tableFingerprint")?,
        ancestry_fingerprint: digest("ancestryFingerprint")?,
        mount_fingerprint: digest("mountFingerprint")?,
    };
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub fn observe(snapshot: &MacDiskSnapshot) -> Result<MacDiskObservation, ObservationError> {
    validate_snapshot(snapshot)?;
    if !snapshot.ancestry_complete {
        return Err(ObservationError::Ineligible);
    }
    let ancestry_complete = snapshot.ancestry_complete;
    let external_usb = snapshot.protocol.to_ascii_lowercase().contains("usb") && snapshot.removable;
    let mut connection = Vec::new();
    connection.extend_from_slice(
        snapshot
            .serial
            .as_deref()
            .unwrap_or("serial-unavailable")
            .as_bytes(),
    );
    connection.push(0);
    connection.extend_from_slice(snapshot.device_tree_path.as_bytes());
    connection.push(0);
    connection.extend_from_slice(&snapshot.capacity_bytes.to_be_bytes());
    connection.extend_from_slice(&snapshot.connection_generation.to_be_bytes());
    let observation = DeviceObservation {
        os_identity: format!("macos:{}", snapshot.identifier),
        connection_identity: hex_bytes(&sha256(&connection)),
        display_identifier: snapshot.identifier.clone(),
        serial: snapshot.serial.clone(),
        model: None,
        capacity_bytes: snapshot.capacity_bytes,
        sector_bytes: snapshot.sector_bytes,
        table_fingerprint: snapshot.table_fingerprint,
        ancestry_fingerprint: snapshot.ancestry_fingerprint,
        mount_fingerprint: snapshot.mount_fingerprint,
        external_usb,
        internal: snapshot.internal,
        system_backing: snapshot.system_backing,
        ancestry_complete,
        writable: snapshot.writable,
    };
    observation
        .validate()
        .map_err(|_| ObservationError::Ineligible)?;
    Ok(MacDiskObservation {
        observation,
        identifier: snapshot.identifier.clone(),
        device_node: snapshot.device_node.clone(),
    })
}

pub fn recheck(
    approved: &DeviceObservation,
    current: &MacDiskSnapshot,
) -> Result<MacDiskObservation, ObservationError> {
    let observed = observe(current)?;
    if &observed.observation != approved {
        return Err(ObservationError::Changed);
    }
    Ok(observed)
}

/// Native enumeration uses diskutil's structured plist output. The partition
/// table is read through the raw device, which only the root helper can open.
pub fn collect_snapshot(identifier: &str) -> Result<MacDiskSnapshot, ObservationError> {
    collect_native(identifier, true)
}

/// The same snapshot without the raw-device table read, so an unprivileged
/// process can list and re-observe disks. The table fingerprint is zero.
pub fn collect_unprivileged(identifier: &str) -> Result<MacDiskSnapshot, ObservationError> {
    collect_native(identifier, false)
}

fn collect_native(identifier: &str, with_table: bool) -> Result<MacDiskSnapshot, ObservationError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (identifier, with_table);
        Err(ObservationError::NativeUnavailable)
    }
    #[cfg(target_os = "macos")]
    {
        validate_identifier(identifier)?;
        let info = diskutil_plist(&["info", "-plist", &format!("/dev/{identifier}")])?;
        let list = diskutil_plist(&["list", "-plist", &format!("/dev/{identifier}")])?;
        let root = diskutil_plist(&["info", "-plist", "/"])?;
        let info = info.as_object().ok_or(ObservationError::InvalidInput)?;
        let whole = string(info, "DeviceIdentifier")?;
        if whole != identifier || !bool_value(info, "Whole")? {
            return Err(ObservationError::Ineligible);
        }
        let node = string(info, "DeviceNode")?;
        if node != format!("/dev/{identifier}") {
            return Err(ObservationError::InvalidInput);
        }
        let capacity_bytes =
            u64_value(info, "TotalSize").or_else(|_| u64_value(info, "DiskSize"))?;
        let connection_generation = media_registry_generation(identifier)?;
        let sector_bytes = u32::try_from(u64_value(info, "DeviceBlockSize")?)
            .map_err(|_| ObservationError::InvalidInput)?;
        let protocol = string(info, "BusProtocol")
            .or_else(|_| string(info, "Protocol"))?
            .to_owned();
        let device_tree_path = string(info, "DeviceTreePath")?.to_owned();
        let internal = bool_value(info, "Internal")?;
        let removable = bool_value(info, "RemovableMedia")?;
        let writable = !bool_value(info, "ReadOnlyMedia").unwrap_or(true);
        let serial = info
            .get("SerialNumber")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let root_obj = root.as_object().ok_or(ObservationError::InvalidInput)?;
        let root_disk = root_obj
            .get("ParentWholeDisk")
            .and_then(Value::as_str)
            .or_else(|| root_obj.get("DeviceIdentifier").and_then(Value::as_str))
            .ok_or(ObservationError::InvalidInput)?;
        let has_apfs_container = root_obj
            .get("APFSContainerReference")
            .or_else(|| root_obj.get("ContainerReference"))
            .and_then(Value::as_str)
            .is_some();
        let root_is_apfs = has_apfs_container
            || root_obj
                .get("FilesystemType")
                .or_else(|| root_obj.get("FilesystemPersonality"))
                .and_then(Value::as_str)
                .is_some_and(|filesystem| filesystem.eq_ignore_ascii_case("apfs"));
        let root_ancestry_complete = !root_is_apfs
            && (root_obj
                .get("ParentWholeDisk")
                .and_then(Value::as_str)
                .is_some_and(|parent| validate_identifier(parent).is_ok())
                || (root_obj.get("Whole").and_then(Value::as_bool) == Some(true)
                    && root_obj
                        .get("DeviceIdentifier")
                        .and_then(Value::as_str)
                        .is_some_and(|id| validate_identifier(id).is_ok())));
        let root_stores = root_physical_stores(&root)?;
        let root_ancestry_complete =
            root_ancestry_complete || (root_is_apfs && !root_stores.is_empty());
        let mut partition_ids = Vec::new();
        collect_partition_ids(&list, &mut partition_ids)?;
        if partition_ids.len() > MAX_PARTITIONS {
            return Err(ObservationError::InvalidInput);
        }
        let system_backing = root_disk == identifier
            || whole_is_ancestor(info, root_disk)
            || root_stores
                .iter()
                .any(|store| physical_store_matches_candidate(identifier, &partition_ids, store));
        let mut partitions = Vec::new();
        for part in partition_ids {
            let part_info = diskutil_plist(&["info", "-plist", &format!("/dev/{part}")])?;
            let part_obj = part_info
                .as_object()
                .ok_or(ObservationError::InvalidInput)?;
            let mount_point = part_obj
                .get("MountPoint")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            partitions.push(MacPartition {
                identifier: part,
                mounted: mount_point.is_some(),
                mount_point,
            });
        }
        partitions.sort();
        let mut ancestry_material = Vec::new();
        ancestry_material.extend_from_slice(device_tree_path.as_bytes());
        ancestry_material.push(0);
        ancestry_material.extend_from_slice(root_disk.as_bytes());
        ancestry_material.push(u8::from(root_ancestry_complete));
        ancestry_material.push(0);
        ancestry_material.extend_from_slice(protocol.as_bytes());
        ancestry_material.push(0);
        for store in &root_stores {
            ancestry_material.extend_from_slice(store.as_bytes());
            ancestry_material.push(0);
        }
        ancestry_material.push(u8::from(internal));
        ancestry_material.push(u8::from(removable));
        // Partition identities only: volumes mount and unmount on their own,
        // and that must not change what the user approved.
        let mut mount_material = Vec::new();
        for part in &partitions {
            mount_material.extend_from_slice(part.identifier.as_bytes());
            mount_material.push(0);
        }
        let table_fingerprint = if with_table {
            const O_CLOEXEC: i32 = 0x0100_0000;
            const O_NOFOLLOW: i32 = 0x0000_0100;
            let disk = OpenOptions::new()
                .read(true)
                .custom_flags(O_CLOEXEC | O_NOFOLLOW)
                .open(format!("/dev/r{identifier}"))
                .map_err(|_| ObservationError::NativeUnavailable)?;
            read_table_fingerprint(&disk, capacity_bytes)?
        } else {
            [0; 32]
        };
        let snapshot = MacDiskSnapshot {
            identifier: identifier.to_owned(),
            device_node: node.to_owned(),
            capacity_bytes,
            connection_generation,
            ancestry_complete: root_ancestry_complete,
            sector_bytes,
            internal,
            removable,
            protocol,
            serial,
            device_tree_path,
            writable,
            partitions,
            system_backing,
            table_fingerprint,
            ancestry_fingerprint: sha256(&ancestry_material),
            mount_fingerprint: sha256(&mount_material),
        };
        validate_snapshot(&snapshot)?;
        Ok(snapshot)
    }
}

/// A retained raw-device handle. Construction needs the helper's
/// non-constructible authenticated-channel proof.
#[cfg(target_os = "macos")]
pub struct MacBlockTarget {
    file: File,
    approved: DeviceObservation,
    identifier: String,
    sender_token: [u8; 32],
    sender_team: String,
    _claim: DiskClaim,
}

#[cfg(target_os = "macos")]
impl MacBlockTarget {
    pub fn open_authenticated(
        channel: &crate::protocol::AuthenticatedChannel,
        approved: &DeviceObservation,
    ) -> Result<Self, ObservationError> {
        channel
            .revalidate_sender()
            .map_err(|_| ObservationError::Changed)?;
        Self::open_after_native_authorisation(approved, channel.peer_token, channel.team.clone())
    }

    fn open_after_native_authorisation(
        approved: &DeviceObservation,
        sender_token: [u8; 32],
        sender_team: String,
    ) -> Result<Self, ObservationError> {
        approved
            .validate()
            .map_err(|_| ObservationError::Ineligible)?;
        let identifier = approved
            .os_identity
            .strip_prefix("macos:")
            .ok_or(ObservationError::InvalidInput)?;
        validate_identifier(identifier)?;

        // Revalidate the full native observation and table before a disk
        // identifier is used for either arbitration or unmounting.
        let before = collect_snapshot(identifier)?;
        let before_observation = recheck(approved, &before)?;
        if before_observation.observation.internal
            || before_observation.observation.system_backing
            || !before_observation.observation.external_usb
            || !before_observation.observation.ancestry_complete
            || !before_observation.observation.writable
        {
            return Err(ObservationError::Ineligible);
        }

        let claim = DiskClaim::acquire(identifier)?;
        let unmount_path = format!("/dev/{identifier}");
        let (status, _) = run_bounded("/usr/sbin/diskutil", &["unmountDisk", &unmount_path], None)?;
        if !status.success() {
            return Err(ObservationError::NativeUnavailable);
        }

        // Only the expected mounted-to-unmounted transition is accepted.
        let after = collect_snapshot(identifier)?;
        let after_observation = observe(&after)?;
        if !after_observation
            .observation
            .same_physical_identity(&before_observation.observation)
            || after.table_fingerprint != before.table_fingerprint
            || !expected_unmount_transition(&before, &after)
        {
            return Err(ObservationError::Changed);
        }

        let raw_path = format!("/dev/r{identifier}");
        const O_CLOEXEC: i32 = 0x0100_0000;
        const O_NOFOLLOW: i32 = 0x0000_0100;
        const O_NONBLOCK: i32 = 0x0000_0004;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
            .open(raw_path)
            .map_err(|_| ObservationError::NativeUnavailable)?;
        let metadata = file
            .metadata()
            .map_err(|_| ObservationError::NativeUnavailable)?;
        if !metadata.file_type().is_char_device() {
            return Err(ObservationError::Ineligible);
        }
        let retained_table = read_table_fingerprint(&file, after.capacity_bytes)?;
        if retained_table != after.table_fingerprint {
            return Err(ObservationError::Changed);
        }
        let after_open = collect_snapshot(identifier)?;
        if after_open.connection_generation != after.connection_generation
            || after_open.table_fingerprint != retained_table
            || after_open.mount_fingerprint != after.mount_fingerprint
        {
            return Err(ObservationError::Changed);
        }
        let mut approved_after = after_observation.observation;
        approved_after.table_fingerprint = retained_table;
        Ok(Self {
            file,
            approved: approved_after,
            identifier: identifier.to_owned(),
            sender_token,
            sender_team,
            _claim: claim,
        })
    }
}

#[cfg(target_os = "macos")]
impl io::Read for MacBlockTarget {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.file.read(buffer)
    }
}
#[cfg(target_os = "macos")]
impl io::Write for MacBlockTarget {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        crate::protocol::macos_transport::verify_peer_token(&self.sender_token, &self.sender_team)
            .map_err(|_| io::Error::other("authenticated sender changed"))?;
        self.file.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
#[cfg(target_os = "macos")]
impl io::Seek for MacBlockTarget {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}

#[cfg(target_os = "macos")]
impl WriteTarget for MacBlockTarget {
    fn observe(&self) -> io::Result<DeviceObservation> {
        let mut snapshot = collect_snapshot(&self.identifier)
            .map_err(|_| io::Error::other("native device recheck failed"))?;
        let path_table = snapshot.table_fingerprint;
        let retained_table = read_table_fingerprint(&self.file, self.approved.capacity_bytes)
            .map_err(|_| io::Error::other("partition table recheck failed"))?;
        if retained_table != path_table {
            return Err(io::Error::other("raw device identity changed"));
        }
        snapshot.table_fingerprint = retained_table;
        let current = observe(&snapshot)
            .map_err(|_| io::Error::other("native device recheck failed"))?
            .observation;
        if !current.same_physical_identity(&self.approved) {
            return Err(io::Error::other("native device identity changed"));
        }
        if current.mount_fingerprint != self.approved.mount_fingerprint {
            return Err(io::Error::other("native mount state changed"));
        }
        Ok(current)
    }
    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        read_aligned(
            &self.file,
            u64::from(self.approved.sector_bytes),
            offset,
            buffer,
        )
    }
    fn lock_exclusive(&mut self) -> io::Result<()> {
        const LOCK_EX: i32 = 2;
        const LOCK_NB: i32 = 4;
        unsafe extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        // SAFETY: flock operates on this retained device descriptor.
        if unsafe { flock(self.file.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    fn flush_durable(&mut self) -> io::Result<()> {
        // F_FULLFSYNC asks the drive itself to flush; plain fsync need not.
        // SAFETY: fcntl operates on this retained descriptor.
        if unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_FULLFSYNC) } == 0 {
            return Ok(());
        }
        self.file.sync_all()
    }
}

/// The whole-disk identifier named by a native identity. Never a path.
pub fn disk_identifier(identity: &str) -> Result<&str, ObservationError> {
    let identifier = identity
        .strip_prefix("macos:")
        .ok_or(ObservationError::Ineligible)?;
    validate_identifier(identifier)?;
    Ok(identifier)
}

/// The device node of the Nth slice of a whole disk.
pub fn partition_node(disk: &str, number: u32) -> String {
    format!("/dev/{disk}s{number}")
}

/// Discover one whole disk from its native identity, including the table
/// fingerprint. The helper derives everything itself and accepts no client path.
pub fn collect_by_identity(identity: &str) -> Result<MacDiskObservation, ObservationError> {
    observe(&collect_snapshot(disk_identifier(identity)?)?)
}

/// Re-observe an approved disk without opening the device. The privileged
/// table fingerprint cannot be re-read here, so it is carried over from the
/// approval; the helper re-reads it and must match the plan digest.
pub fn observe_unprivileged(
    approved: &DeviceObservation,
) -> Result<DeviceObservation, ObservationError> {
    let mut snapshot = collect_unprivileged(disk_identifier(&approved.os_identity)?)?;
    snapshot.table_fingerprint = approved.table_fingerprint;
    observe(&snapshot).map(|entry| entry.observation)
}

/// Recheck the physical connection before mounting or ejecting our newly
/// written partition. Mount state is not part of the identity.
pub fn verify_connection(approved: &DeviceObservation) -> Result<(), ObservationError> {
    let current = observe_unprivileged(approved)?;
    if approved.same_physical_identity(&current) {
        Ok(())
    } else {
        Err(ObservationError::Changed)
    }
}

/// Whole-disk identifiers from `diskutil list -plist`, in natural order.
fn whole_disk_ids(listing: &Value) -> Vec<String> {
    let mut ids = listing
        .get("WholeDisks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| validate_identifier(id).is_ok())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| (id.len(), id.clone()));
    ids.dedup();
    ids
}

/// Unprivileged enumeration for the device selector. Only external USB whole
/// disks that are writable, not internal and not backing system storage pass
/// `observe`; anything that fails observation is omitted rather than guessed.
pub fn list_eligible() -> Vec<MacDiskObservation> {
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
    #[cfg(target_os = "macos")]
    {
        let Ok(listing) = diskutil_plist(&["list", "-plist", "external", "physical"]) else {
            return Vec::new();
        };
        whole_disk_ids(&listing)
            .iter()
            .filter_map(|id| observe(&collect_unprivileged(id).ok()?).ok())
            .collect()
    }
}

/// Bounded read-only GPT preview, pinned to the same whole-device observation.
pub fn update_snapshot(
    identity: &str,
) -> Result<ais_host_core::update::DriveSnapshot, ObservationError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = identity;
        Err(ObservationError::NativeUnavailable)
    }
    #[cfg(target_os = "macos")]
    {
        let observed = collect_by_identity(identity)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(0x0100_0000 | 0x0000_0100 | 0x0000_0004) // CLOEXEC, NOFOLLOW, NONBLOCK.
            .open(format!("/dev/r{}", observed.identifier))
            .map_err(|_| ObservationError::InvalidInput)?;
        if !file
            .metadata()
            .map_err(|_| ObservationError::InvalidInput)?
            .file_type()
            .is_char_device()
        {
            return Err(ObservationError::Changed);
        }
        let sector = u64::from(observed.observation.sector_bytes);
        let snapshot = ais_host_core::update::DriveSnapshot::read(
            observed.observation.clone(),
            |offset, bytes| read_aligned(&file, sector, offset, bytes),
        )
        .map_err(|_| ObservationError::Changed)?;
        if collect_by_identity(identity)?.observation != observed.observation {
            return Err(ObservationError::Changed);
        }
        Ok(snapshot)
    }
}

/// Raw macOS devices only accept whole-sector transfers, so read the covering
/// sectors and copy out the requested bytes.
#[cfg(unix)]
fn read_aligned(
    file: &std::fs::File,
    sector: u64,
    offset: u64,
    buffer: &mut [u8],
) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    let end = offset
        .checked_add(buffer.len() as u64)
        .ok_or_else(|| std::io::Error::other("read range overflows"))?;
    let start = offset - offset % sector;
    let mut window = vec![0; (end.div_ceil(sector) * sector - start) as usize];
    file.read_exact_at(&mut window, start)?;
    let skip = (offset - start) as usize;
    buffer.copy_from_slice(&window[skip..skip + buffer.len()]);
    Ok(())
}

/// Mount the exchange slice (slice 4) and return its mount point. The slice
/// must be the exFAT volume named AISX with exactly the planned size, and,
/// where diskutil reports them, the planned partition GUID and offset.
#[cfg(target_os = "macos")]
pub fn mount_exchange(
    disk: &str,
    length: u64,
    start: u64,
    partition_guid: &str,
) -> Result<(String, std::path::PathBuf), ObservationError> {
    validate_identifier(disk)?;
    let node = partition_node(disk, 4);
    // The system probes a freshly written table asynchronously.
    let mut info = None;
    for _ in 0..75 {
        if let Ok(value) = diskutil_plist(&["info", "-plist", &node]) {
            info = Some(value);
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    let slice = |info: &Value| -> Result<(), ObservationError> {
        let info = info.as_object().ok_or(ObservationError::InvalidInput)?;
        let size = u64_value(info, "TotalSize").or_else(|_| u64_value(info, "Size"))?;
        let filesystem = string(info, "FilesystemType")
            .or_else(|_| string(info, "FilesystemName"))?
            .to_ascii_lowercase();
        let uuid_matches = info
            .get("DiskUUID")
            .and_then(Value::as_str)
            .is_none_or(|uuid| uuid.eq_ignore_ascii_case(partition_guid));
        let offset_matches = info
            .get("PartitionMapPartitionOffset")
            .and_then(Value::as_u64)
            .is_none_or(|offset| offset == start);
        if size != length
            || filesystem != "exfat"
            || string(info, "VolumeName")? != "AISX"
            || !uuid_matches
            || !offset_matches
        {
            return Err(ObservationError::Changed);
        }
        Ok(())
    };
    slice(&info.ok_or(ObservationError::NativeUnavailable)?)?;
    let (status, _) = run_bounded(
        "/usr/sbin/diskutil",
        &["mount", "-mountOptions", "nosuid,nodev", &node],
        None,
    )?;
    if !status.success() {
        return Err(ObservationError::NativeUnavailable);
    }
    // Derive the mount point from the system after mounting, not from output.
    let info = diskutil_plist(&["info", "-plist", &node])?;
    slice(&info)?;
    let mount_point = string(
        info.as_object().ok_or(ObservationError::InvalidInput)?,
        "MountPoint",
    )?;
    let mount_point = std::path::PathBuf::from(mount_point);
    if !mount_point.is_absolute() || mount_point.parent().is_none() {
        return Err(ObservationError::InvalidInput);
    }
    Ok((node, mount_point))
}

/// Unmount one slice by its device node.
#[cfg(target_os = "macos")]
pub fn unmount_slice(node: &str) -> Result<(), ObservationError> {
    let (status, _) = run_bounded("/usr/sbin/diskutil", &["unmount", node], None)?;
    status
        .success()
        .then_some(())
        .ok_or(ObservationError::NativeUnavailable)
}

/// Eject a whole disk after unmounting it.
#[cfg(target_os = "macos")]
pub fn eject_disk(disk: &str) -> Result<(), ObservationError> {
    validate_identifier(disk)?;
    let (status, _) = run_bounded(
        "/usr/sbin/diskutil",
        &["eject", &format!("/dev/{disk}")],
        None,
    )?;
    status
        .success()
        .then_some(())
        .ok_or(ObservationError::NativeUnavailable)
}

#[cfg(target_os = "macos")]
fn diskutil_plist(args: &[&str]) -> Result<Value, ObservationError> {
    let (status, output) = run_bounded("/usr/sbin/diskutil", args, None)?;
    if !status.success() {
        return Err(ObservationError::NativeUnavailable);
    }
    let (status, converted) = run_bounded(
        "/usr/bin/plutil",
        &["-convert", "json", "-o", "-", "-"],
        Some(&output),
    )?;
    if !status.success() {
        return Err(ObservationError::NativeUnavailable);
    }
    serde_json::from_slice(&converted).map_err(|_| ObservationError::InvalidInput)
}

#[cfg(target_os = "macos")]
fn run_bounded(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<(ExitStatus, Vec<u8>), ObservationError> {
    let mut command = Command::new(program);
    command
        .env_clear()
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| ObservationError::NativeUnavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ObservationError::NativeUnavailable)?;
    let (output_tx, output_rx) = mpsc::sync_channel(1);
    let output_overflow = Arc::new(AtomicBool::new(false));
    let reader_overflow = Arc::clone(&output_overflow);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take((MAX_PLIST_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        if bytes.len() > MAX_PLIST_BYTES {
            reader_overflow.store(true, Ordering::Release);
        }
        let _ = output_tx.send((result, bytes));
    });
    let writer = input.map(|input| {
        let input = input.to_vec();
        let mut stdin = child.stdin.take();
        thread::spawn(move || match stdin.as_mut() {
            Some(stdin) => stdin.write_all(&input),
            None => Err(io::Error::other("subprocess stdin unavailable")),
        })
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if output_overflow.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            if let Some(writer) = writer {
                let _ = writer.join();
            }
            return Err(ObservationError::NativeUnavailable);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                if let Some(writer) = writer {
                    let _ = writer.join();
                }
                return Err(ObservationError::NativeUnavailable);
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            if let Some(writer) = writer {
                let _ = writer.join();
            }
            return Err(ObservationError::NativeUnavailable);
        }
        thread::sleep(Duration::from_millis(10));
    };
    if let Some(writer) = writer
        && writer.join().map_or(true, |result| result.is_err())
    {
        let _ = reader.join();
        return Err(ObservationError::NativeUnavailable);
    }
    let (read_result, bytes) = output_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| ObservationError::NativeUnavailable)?;
    let _ = reader.join();
    read_result.map_err(|_| ObservationError::NativeUnavailable)?;
    if bytes.len() > MAX_PLIST_BYTES {
        return Err(ObservationError::NativeUnavailable);
    }
    Ok((status, bytes))
}

#[cfg(target_os = "macos")]
fn media_registry_generation(identifier: &str) -> Result<u64, ObservationError> {
    use std::ffi::CString;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOBSDNameMatching(port: u32, options: u32, name: *const i8) -> *mut std::ffi::c_void;
        fn IOServiceGetMatchingService(port: u32, matching: *mut std::ffi::c_void) -> u32;
        fn IOObjectConformsTo(object: u32, class_name: *const i8) -> u32;
        fn IORegistryEntryGetRegistryEntryID(entry: u32, identifier: *mut u64) -> i32;
        fn IOObjectRelease(object: u32) -> i32;
    }

    let name = CString::new(identifier).map_err(|_| ObservationError::InvalidInput)?;
    // kIOMainPortDefault is zero. The BSD-name match is consumed by lookup.
    let matching = unsafe { IOBSDNameMatching(0, 0, name.as_ptr()) };
    if matching.is_null() {
        return Err(ObservationError::NativeUnavailable);
    }
    let service = unsafe { IOServiceGetMatchingService(0, matching) };
    if service == 0 {
        return Err(ObservationError::NativeUnavailable);
    }
    let media_class = CString::new("IOMedia").map_err(|_| ObservationError::InvalidInput)?;
    let is_media = unsafe { IOObjectConformsTo(service, media_class.as_ptr()) != 0 };
    let mut entry_id = 0;
    let status = if is_media {
        unsafe { IORegistryEntryGetRegistryEntryID(service, &mut entry_id) }
    } else {
        -1
    };
    unsafe { IOObjectRelease(service) };
    if status != 0 || entry_id == 0 {
        return Err(ObservationError::NativeUnavailable);
    }
    Ok(entry_id)
}

#[cfg(target_os = "macos")]
fn root_physical_stores(root: &Value) -> Result<Vec<String>, ObservationError> {
    let root_obj = root.as_object().ok_or(ObservationError::InvalidInput)?;
    let Some(container) = root_obj
        .get("APFSContainerReference")
        .or_else(|| root_obj.get("ContainerReference"))
        .and_then(Value::as_str)
    else {
        // Non-APFS roots are still checked by their native whole-disk parent.
        return Ok(Vec::new());
    };
    validate_identifier(container)?;
    let apfs = diskutil_plist(&["apfs", "list", "-plist"])?;
    let container_obj =
        find_apfs_container(&apfs, container).ok_or(ObservationError::NativeUnavailable)?;
    let stores = container_obj
        .get("PhysicalStores")
        .and_then(Value::as_array)
        .ok_or(ObservationError::NativeUnavailable)?;
    let mut identifiers = Vec::with_capacity(stores.len());
    for store in stores {
        let id = store
            .as_str()
            .or_else(|| store.get("DeviceIdentifier").and_then(Value::as_str))
            .ok_or(ObservationError::InvalidInput)?;
        validate_identifier(id)?;
        identifiers.push(id.to_owned());
    }
    identifiers.sort();
    identifiers.dedup();
    if identifiers.is_empty() {
        return Err(ObservationError::NativeUnavailable);
    }
    Ok(identifiers)
}

fn find_apfs_container<'a>(
    value: &'a Value,
    expected: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    match value {
        Value::Object(object) => {
            let id = object
                .get("APFSContainerReference")
                .or_else(|| object.get("ContainerReference"))
                .and_then(Value::as_str);
            if id == Some(expected) && object.contains_key("PhysicalStores") {
                return Some(object);
            }
            object
                .values()
                .find_map(|child| find_apfs_container(child, expected))
        }
        Value::Array(array) => array
            .iter()
            .find_map(|child| find_apfs_container(child, expected)),
        _ => None,
    }
}

fn expected_unmount_transition(before: &MacDiskSnapshot, after: &MacDiskSnapshot) -> bool {
    if before.partitions.len() != after.partitions.len() {
        return false;
    }
    before
        .partitions
        .iter()
        .zip(&after.partitions)
        .all(|(old, new)| old.identifier == new.identifier && (!new.mounted || old.mounted))
        && after.partitions.iter().all(|part| !part.mounted)
}

fn physical_store_matches_candidate(candidate: &str, partitions: &[String], store: &str) -> bool {
    if store == candidate {
        return validate_identifier(candidate).is_ok();
    }

    validate_partition_identifier(candidate, store).is_ok()
        && partitions.iter().any(|partition| partition == store)
}

#[cfg(target_os = "macos")]
struct DiskClaim {
    session: *mut std::ffi::c_void,
    disk: *mut std::ffi::c_void,
}

#[cfg(target_os = "macos")]
unsafe impl Send for DiskClaim {}

#[cfg(target_os = "macos")]
impl Drop for DiskClaim {
    fn drop(&mut self) {
        unsafe extern "C" {
            fn DADiskUnclaim(disk: *mut std::ffi::c_void);
            fn CFRelease(object: *const std::ffi::c_void);
        }
        // SAFETY: these retained references are owned by this RAII object.
        unsafe {
            DADiskUnclaim(self.disk);
            CFRelease(self.disk);
            CFRelease(self.session);
        }
    }
}

#[cfg(target_os = "macos")]
impl DiskClaim {
    fn acquire(identifier: &str) -> Result<Self, ObservationError> {
        use std::{ffi::CString, sync::mpsc};

        type Ref = *mut std::ffi::c_void;
        type Dissenter = *const std::ffi::c_void;
        type Callback = unsafe extern "C" fn(Ref, Dissenter, *mut std::ffi::c_void);
        type ReleaseCallback = unsafe extern "C" fn(Ref, *mut std::ffi::c_void) -> Dissenter;
        #[link(name = "DiskArbitration", kind = "framework")]
        unsafe extern "C" {
            fn DASessionCreate(allocator: Ref) -> Ref;
            fn DASessionSetDispatchQueue(session: Ref, queue: Ref);
            fn DADiskCreateFromBSDName(allocator: Ref, session: Ref, name: *const i8) -> Ref;
            fn DADiskClaim(
                disk: Ref,
                options: u32,
                release: Option<ReleaseCallback>,
                release_context: *mut std::ffi::c_void,
                callback: Option<Callback>,
                callback_context: *mut std::ffi::c_void,
            );
        }
        #[link(name = "System")]
        unsafe extern "C" {
            fn dispatch_get_global_queue(identifier: isize, flags: usize) -> Ref;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFRelease(object: *const std::ffi::c_void);
        }
        #[link(name = "DiskArbitration", kind = "framework")]
        unsafe extern "C" {
            fn DADissenterCreate(
                allocator: *const std::ffi::c_void,
                status: i32,
                string: *const std::ffi::c_void,
            ) -> Dissenter;
        }
        // DiskArbitration enum value (err_local | err_local_diskarbitration | 0x0D), not a symbol.
        const DA_RETURN_NOT_PERMITTED: i32 = 0xF800_000Du32 as i32;
        struct ClaimResult(mpsc::SyncSender<bool>);
        unsafe extern "C" fn claimed(_: Ref, dissenter: Dissenter, context: *mut std::ffi::c_void) {
            // SAFETY: the callback owns the raw Arc reference created below.
            // This remains valid even when the synchronous wait timed out.
            let result = unsafe { Arc::from_raw(context.cast::<ClaimResult>()) };
            let _ = result.0.send(dissenter.is_null());
        }
        unsafe extern "C" fn refuse_release(_: Ref, _: *mut std::ffi::c_void) -> Dissenter {
            // Apple documents a non-null dissenter as the response that keeps
            // a Disk Arbitration claim from being released on request.
            unsafe {
                DADissenterCreate(std::ptr::null(), DA_RETURN_NOT_PERMITTED, std::ptr::null())
            }
        }

        let session = unsafe { DASessionCreate(std::ptr::null_mut()) };
        if session.is_null() {
            return Err(ObservationError::NativeUnavailable);
        }
        let queue = unsafe { dispatch_get_global_queue(0, 0) };
        if queue.is_null() {
            unsafe { CFRelease(session) };
            return Err(ObservationError::NativeUnavailable);
        }
        unsafe { DASessionSetDispatchQueue(session, queue) };
        let name = match CString::new(identifier) {
            Ok(name) => name,
            Err(_) => {
                unsafe { CFRelease(session) };
                return Err(ObservationError::InvalidInput);
            }
        };
        let disk = unsafe { DADiskCreateFromBSDName(std::ptr::null_mut(), session, name.as_ptr()) };
        if disk.is_null() {
            unsafe { CFRelease(session) };
            return Err(ObservationError::NativeUnavailable);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_context = Arc::into_raw(Arc::new(ClaimResult(sender)));
        unsafe {
            DADiskClaim(
                disk,
                0,
                Some(refuse_release),
                std::ptr::null_mut(),
                Some(claimed),
                callback_context.cast_mut().cast(),
            )
        };
        let claim_result = receiver.recv_timeout(Duration::from_secs(30));
        if !matches!(claim_result, Ok(true)) {
            if claim_result.is_ok() {
                unsafe {
                    CFRelease(disk);
                    CFRelease(session);
                }
                return Err(ObservationError::NativeUnavailable);
            }
            // A timeout may race a late DA callback. Keep the references alive
            // rather than releasing objects while Disk Arbitration may still
            // be completing the claim.
            return Err(ObservationError::NativeUnavailable);
        }
        Ok(Self { session, disk })
    }
}

#[cfg(target_os = "macos")]
fn collect_partition_ids(value: &Value, out: &mut Vec<String>) -> Result<(), ObservationError> {
    let disks = value
        .get("AllDisksAndPartitions")
        .and_then(Value::as_array)
        .ok_or(ObservationError::InvalidInput)?;
    for disk in disks {
        let whole = disk
            .get("DeviceIdentifier")
            .and_then(Value::as_str)
            .ok_or(ObservationError::InvalidInput)?;
        validate_identifier(whole)?;
        if let Some(parts) = disk.get("Partitions") {
            for part in parts.as_array().ok_or(ObservationError::InvalidInput)? {
                let id = part
                    .get("DeviceIdentifier")
                    .and_then(Value::as_str)
                    .ok_or(ObservationError::InvalidInput)?;
                validate_partition_identifier(whole, id)?;
                out.push(id.to_owned());
            }
        }
    }
    out.sort();
    if out.windows(2).any(|window| window[0] == window[1]) {
        return Err(ObservationError::InvalidInput);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_table_fingerprint(file: &File, capacity_bytes: u64) -> Result<[u8; 32], ObservationError> {
    if capacity_bytes < (TABLE_WINDOW_BYTES * 2) as u64 || !capacity_bytes.is_multiple_of(512) {
        return Err(ObservationError::InvalidInput);
    }
    let mut head = vec![0; TABLE_WINDOW_BYTES];
    let mut tail = vec![0; TABLE_WINDOW_BYTES];
    read_exact_at(file, 0, &mut head)?;
    read_exact_at(file, capacity_bytes - TABLE_WINDOW_BYTES as u64, &mut tail)?;
    ais_host_core::device::table_fingerprint(&head, &tail)
        .map_err(|_| ObservationError::InvalidInput)
}

#[cfg(target_os = "macos")]
fn read_exact_at(
    file: &File,
    mut offset: u64,
    mut bytes: &mut [u8],
) -> Result<(), ObservationError> {
    while !bytes.is_empty() {
        let count = file
            .read_at(bytes, offset)
            .map_err(|_| ObservationError::NativeUnavailable)?;
        if count == 0 {
            return Err(ObservationError::NativeUnavailable);
        }
        offset += count as u64;
        bytes = &mut bytes[count..];
    }
    Ok(())
}

fn validate_snapshot(snapshot: &MacDiskSnapshot) -> Result<(), ObservationError> {
    validate_identifier(&snapshot.identifier)?;
    if snapshot.device_node != format!("/dev/{}", snapshot.identifier)
        || snapshot.capacity_bytes == 0
        || snapshot.connection_generation == 0
        || !matches!(snapshot.sector_bytes, 512 | 4096)
        || !snapshot
            .capacity_bytes
            .is_multiple_of(u64::from(snapshot.sector_bytes))
        || snapshot.protocol.is_empty()
        || snapshot.device_tree_path.is_empty()
        || snapshot.partitions.len() > MAX_PARTITIONS
        || snapshot.partitions.iter().any(|part| {
            validate_partition_identifier(&snapshot.identifier, &part.identifier).is_err()
        })
        || snapshot
            .partitions
            .windows(2)
            .any(|pair| pair[0].identifier == pair[1].identifier)
    {
        return Err(ObservationError::InvalidInput);
    }
    Ok(())
}

fn validate_identifier(identifier: &str) -> Result<(), ObservationError> {
    let digits = identifier
        .strip_prefix("disk")
        .ok_or(ObservationError::InvalidInput)?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ObservationError::InvalidInput);
    }
    Ok(())
}
fn validate_partition_identifier(whole: &str, partition: &str) -> Result<(), ObservationError> {
    validate_identifier(whole)?;
    let suffix = partition
        .strip_prefix(whole)
        .ok_or(ObservationError::InvalidInput)?;
    let slice = suffix
        .strip_prefix('s')
        .ok_or(ObservationError::InvalidInput)?;
    if slice.is_empty() || !slice.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ObservationError::InvalidInput);
    }
    Ok(())
}
fn string<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, ObservationError> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(ObservationError::InvalidInput)
}
fn bool_value(obj: &serde_json::Map<String, Value>, key: &str) -> Result<bool, ObservationError> {
    obj.get(key)
        .and_then(Value::as_bool)
        .ok_or(ObservationError::InvalidInput)
}
fn u64_value(obj: &serde_json::Map<String, Value>, key: &str) -> Result<u64, ObservationError> {
    obj.get(key)
        .and_then(Value::as_u64)
        .ok_or(ObservationError::InvalidInput)
}
#[cfg(target_os = "macos")]
fn whole_is_ancestor(candidate: &serde_json::Map<String, Value>, root: &str) -> bool {
    candidate.get("ParentWholeDisk").and_then(Value::as_str) == Some(root)
}
fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod native_logic_tests {
    use super::{
        MacDiskSnapshot, MacPartition, ObservationError, disk_identifier,
        expected_unmount_transition, find_apfs_container, observe, partition_node,
        physical_store_matches_candidate, whole_disk_ids,
    };
    use serde_json::json;

    #[test]
    fn only_external_writable_usb_disks_outside_the_system_are_eligible() {
        let eligible = observe(&snapshot(false)).unwrap();
        assert_eq!(eligible.observation.os_identity, "macos:disk42");
        assert!(eligible.observation.external_usb);
        let refused = |change: fn(&mut MacDiskSnapshot)| {
            let mut disk = snapshot(false);
            change(&mut disk);
            observe(&disk).unwrap_err()
        };
        assert_eq!(refused(|d| d.internal = true), ObservationError::Ineligible);
        assert_eq!(
            refused(|d| d.removable = false),
            ObservationError::Ineligible
        );
        assert_eq!(
            refused(|d| d.protocol = "Apple Fabric".into()),
            ObservationError::Ineligible
        );
        assert_eq!(
            refused(|d| d.writable = false),
            ObservationError::Ineligible
        );
        assert_eq!(
            refused(|d| d.system_backing = true),
            ObservationError::Ineligible
        );
        assert_eq!(
            refused(|d| d.ancestry_complete = false),
            ObservationError::Ineligible
        );
        assert_eq!(
            refused(|d| d.sector_bytes = 1024),
            ObservationError::InvalidInput
        );
    }

    #[test]
    fn identities_are_whole_disk_names_never_paths() {
        assert_eq!(disk_identifier("macos:disk7"), Ok("disk7"));
        for bad in [
            "disk7",
            "macos:",
            "macos:disk",
            "macos:disk7s1",
            "macos:/dev/disk7",
            "macos:../disk7",
            "macos:disk7 ",
            "linux:8:16",
        ] {
            assert!(disk_identifier(bad).is_err(), "{bad}");
        }
        assert_eq!(partition_node("disk7", 4), "/dev/disk7s4");
    }

    #[test]
    fn lists_only_well_formed_whole_disks_in_numeric_order() {
        let listing = json!({
            "WholeDisks": ["disk10", "disk2", "disk2", "../disk1", "disk3s1", 7, "disk"]
        });
        assert_eq!(whole_disk_ids(&listing), ["disk2", "disk10"]);
        assert!(whole_disk_ids(&json!({})).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn raw_reads_cover_whole_sectors_and_return_only_the_requested_bytes() {
        let path = std::env::temp_dir().join(format!("ais-aligned-{}", std::process::id()));
        let bytes: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        for (offset, length) in [(0, 512), (3, 5), (510, 4), (1000, 1500), (4090, 6)] {
            let mut buffer = vec![0; length];
            super::read_aligned(&file, 512, offset as u64, &mut buffer).unwrap();
            assert_eq!(buffer, bytes[offset..offset + length]);
        }
        let mut past = [0; 8];
        assert!(super::read_aligned(&file, 512, 4092, &mut past).is_err());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn maps_apfs_partition_store_back_to_its_whole_disk() {
        let partitions = vec!["disk42s2".to_owned()];
        assert!(physical_store_matches_candidate(
            "disk42",
            &partitions,
            "disk42s2"
        ));
        assert!(physical_store_matches_candidate(
            "disk42",
            &partitions,
            "disk42"
        ));
        assert!(!physical_store_matches_candidate(
            "disk43",
            &partitions,
            "disk42s2"
        ));
    }

    #[test]
    fn finds_only_the_matching_apfs_container_and_its_physical_stores() {
        let listing = json!({
            "Containers": [
                { "ContainerReference": "disk3", "PhysicalStores": ["disk42s2"] },
                { "ContainerReference": "disk4", "PhysicalStores": ["disk99s1"] }
            ]
        });
        let container = find_apfs_container(&listing, "disk3").unwrap();
        assert_eq!(container["PhysicalStores"][0], "disk42s2");
        assert!(find_apfs_container(&listing, "disk5").is_none());
    }

    #[test]
    fn accepts_only_a_mounted_to_unmounted_partition_transition() {
        let before = snapshot(true);
        let after = snapshot(false);
        assert!(expected_unmount_transition(&before, &after));
        assert!(!expected_unmount_transition(&after, &before));
    }

    fn snapshot(mounted: bool) -> MacDiskSnapshot {
        MacDiskSnapshot {
            identifier: "disk42".to_owned(),
            device_node: "/dev/disk42".to_owned(),
            capacity_bytes: 32_000_000_000,
            connection_generation: 42001,
            ancestry_complete: true,
            sector_bytes: 512,
            internal: false,
            removable: true,
            protocol: "USB".to_owned(),
            serial: Some("SYNTHETIC_FIXTURE".to_owned()),
            device_tree_path: "IOUSBHostDevice/SYNTHETIC_FIXTURE".to_owned(),
            writable: true,
            partitions: vec![MacPartition {
                identifier: "disk42s2".to_owned(),
                mounted,
                mount_point: mounted.then(|| "/Volumes/SYNTHETIC_FIXTURE".to_owned()),
            }],
            system_backing: false,
            table_fingerprint: [1; 32],
            ancestry_fingerprint: [2; 32],
            mount_fingerprint: if mounted { [3; 32] } else { [4; 32] },
        }
    }
}

/// Exercises the real diskutil and IOKit paths on an attached, unmounted disk
/// image. An image is not USB hardware, so the point is that it is observed
/// without privilege yet never listed or accepted as a write target.
#[cfg(all(test, target_os = "macos"))]
mod disk_image_tests {
    use super::{ObservationError, collect_unprivileged, list_eligible, observe};
    use std::{fs::File, process::Command};

    struct Attached {
        node: String,
        image: std::path::PathBuf,
    }

    impl Attached {
        fn new() -> Self {
            let image = std::env::temp_dir().join(format!("ais-host-{}.img", std::process::id()));
            File::create(&image)
                .unwrap()
                .set_len(16 * 1024 * 1024)
                .unwrap();
            let output = Command::new("/usr/bin/hdiutil")
                .args([
                    "attach",
                    "-nomount",
                    "-imagekey",
                    "diskimage-class=CRawDiskImage",
                ])
                .arg(&image)
                .output()
                .unwrap();
            assert!(output.status.success(), "hdiutil attach failed");
            let text = String::from_utf8(output.stdout).unwrap();
            let node = text.split_whitespace().next().unwrap().to_owned();
            assert!(node.starts_with("/dev/disk"), "{text}");
            Self { node, image }
        }
    }

    impl Drop for Attached {
        fn drop(&mut self) {
            let _ = Command::new("/usr/bin/hdiutil")
                .args(["detach", "-force", &self.node])
                .status();
            let _ = std::fs::remove_file(&self.image);
        }
    }

    #[test]
    fn an_attached_disk_image_is_observed_but_never_eligible() {
        let attached = Attached::new();
        let identifier = attached.node.trim_start_matches("/dev/").to_owned();
        match collect_unprivileged(&identifier) {
            Ok(snapshot) => {
                assert_eq!(snapshot.identifier, identifier);
                assert_eq!(snapshot.capacity_bytes, 16 * 1024 * 1024);
                assert!(!snapshot.system_backing);
                assert_eq!(
                    observe(&snapshot).unwrap_err(),
                    ObservationError::Ineligible
                );
            }
            // diskutil gives images no device tree path; refusing is also correct.
            Err(error) => assert_eq!(error, ObservationError::InvalidInput),
        }
        assert!(
            list_eligible()
                .iter()
                .all(|disk| disk.identifier != identifier)
        );
    }
}
