use crate::layout::{
    GPT_ARRAY_BYTES, GPT_ARRAY_SECTORS, GPT_TRAILER_SECTORS, LiveImageLayout, SECTOR_BYTES,
};
use crate::release::{VerifiedImage, sha256};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub id: String,
    pub display_identifier: String,
    pub model: Option<String>,
    pub capacity_bytes: u64,
    pub transport: String,
    pub system: bool,
    pub writable: bool,
    pub serial: Option<String>,
    pub layout_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_error: Option<String>,
}

/// Observations must come from native ancestry inspection, never webview input.
/// A connection identity is required even where the hardware has no serial.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceObservation {
    pub os_identity: String,
    pub connection_identity: String,
    pub display_identifier: String,
    pub serial: Option<String>,
    pub model: Option<String>,
    pub capacity_bytes: u64,
    pub sector_bytes: u32,
    pub table_fingerprint: [u8; 32],
    pub ancestry_fingerprint: [u8; 32],
    pub mount_fingerprint: [u8; 32],
    pub external_usb: bool,
    pub internal: bool,
    pub system_backing: bool,
    pub ancestry_complete: bool,
    pub writable: bool,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DeviceError {
    #[error("The device is not an eligible external USB target.")]
    Ineligible,
    #[error("The device identity, capacity, partitions or mounts changed.")]
    Changed,
    #[error("The planned range is unaligned or outside the device.")]
    Bounds,
    #[error("Type the exact displayed device identifier.")]
    Confirmation,
    #[error("The confirmation expired, was invalidated or has already been used.")]
    Stale,
    #[error("Secure confirmation generation failed.")]
    Entropy,
    #[error("This operation needs a reviewed image layout contract.")]
    LayoutUnavailable,
    #[error("The target does not leave aligned space for the next creation phase.")]
    InsufficientCapacity,
    #[error("The bounded partition-table snapshot is invalid.")]
    TableFingerprint,
}

pub const TABLE_WINDOW_SECTORS: u64 = 34;
pub const TABLE_WINDOW_BYTES: usize = (TABLE_WINDOW_SECTORS * 512) as usize;

/// Canonical bounded GPT fingerprint shared by native observers and the writer.
pub fn table_fingerprint(head: &[u8], tail: &[u8]) -> Result<[u8; 32], DeviceError> {
    if head.len() != TABLE_WINDOW_BYTES || tail.len() != TABLE_WINDOW_BYTES {
        return Err(DeviceError::TableFingerprint);
    }
    let mut bytes = Vec::with_capacity(TABLE_WINDOW_BYTES * 2);
    bytes.extend_from_slice(head);
    bytes.extend_from_slice(tail);
    Ok(sha256(&bytes))
}

impl DeviceObservation {
    pub fn validate(&self) -> Result<(), DeviceError> {
        if self.os_identity.is_empty()
            || self.connection_identity.is_empty()
            || self.display_identifier.trim().is_empty()
            || self.display_identifier.chars().any(char::is_control)
            || !self.external_usb
            || self.internal
            || self.system_backing
            || !self.ancestry_complete
            || !self.writable
        {
            return Err(DeviceError::Ineligible);
        }
        if !matches!(self.sector_bytes, 512 | 4096)
            || self.capacity_bytes == 0
            || !self
                .capacity_bytes
                .is_multiple_of(u64::from(self.sector_bytes))
        {
            return Err(DeviceError::Bounds);
        }
        Ok(())
    }

    /// Stable identity fields used while the planned table changes during a
    /// write. Mutable mount and partition fingerprints are checked before the
    /// first byte, then the native adapter must retain the same open handle.
    pub fn same_physical_identity(&self, other: &Self) -> bool {
        self.os_identity == other.os_identity
            && self.connection_identity == other.connection_identity
            && self.serial == other.serial
            && self.model == other.model
            && self.capacity_bytes == other.capacity_bytes
            && self.sector_bytes == other.sector_bytes
            && self.ancestry_fingerprint == other.ancestry_fingerprint
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteOperation {
    CreateLayout,
    ReplaceBase,
    ResetPersist,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: u64,
    pub length: u64,
}

impl ByteRange {
    pub fn validate(self, device: &DeviceObservation) -> Result<(), DeviceError> {
        let sector = u64::from(device.sector_bytes);
        if sector == 0
            || self.length == 0
            || !self.start.is_multiple_of(sector)
            || !self.length.is_multiple_of(sector)
            || self
                .start
                .checked_add(self.length)
                .is_none_or(|end| end > device.capacity_bytes)
        {
            return Err(DeviceError::Bounds);
        }
        Ok(())
    }
}

/// A serialisable review, but never a deserialisable authority to write.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePlan {
    operation: WriteOperation,
    device: DeviceObservation,
    source_digest: [u8; 32],
    compressed_digest: [u8; 32],
    release: crate::release::ReleaseSelection,
    ranges: Vec<ByteRange>,
    writes: Vec<PlannedWrite>,
    remaining_bytes: u64,
    phase_aware: bool,
    exchange: Option<ByteRange>,
    identity: Option<crate::drive_identity::DriveIdentity>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedWrite {
    range: ByteRange,
    source: WriteSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
enum WriteSource {
    Image { offset: u64 },
    Bytes(#[serde(serialize_with = "serialize_write_digest")] Vec<u8>),
    Zeroes,
}

fn serialize_write_digest<S: serde::Serializer>(
    bytes: &[u8],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    // Bind every replacement byte without serialising an entire ESP into each confirmation.
    sha256(bytes).serialize(serializer)
}

impl WritePlan {
    pub fn create_layout(
        image: &VerifiedImage,
        device: DeviceObservation,
    ) -> Result<Self, DeviceError> {
        device.validate()?;
        if device.sector_bytes as u64 != SECTOR_BYTES {
            return Err(DeviceError::Bounds);
        }
        let layout =
            LiveImageLayout::parse(image.bytes()).map_err(|_| DeviceError::LayoutUnavailable)?;
        let target_sectors = device.capacity_bytes / SECTOR_BYTES;
        let p4_end = layout.p4_end_lba();
        let target_last_usable = target_sectors
            .checked_sub(GPT_TRAILER_SECTORS + 1)
            .ok_or(DeviceError::InsufficientCapacity)?;
        let remaining_bytes = target_last_usable
            .checked_add(1)
            .and_then(|end| end.checked_sub(p4_end))
            .and_then(|sectors| sectors.checked_mul(SECTOR_BYTES))
            .filter(|bytes| *bytes >= SECTOR_BYTES && bytes % SECTOR_BYTES == 0)
            .ok_or(DeviceError::InsufficientCapacity)?;

        let source = image.bytes();
        let mut primary_header = source
            .get(SECTOR_BYTES as usize..(2 * SECTOR_BYTES) as usize)
            .ok_or(DeviceError::LayoutUnavailable)?
            .to_vec();
        crate::layout::put_u64(&mut primary_header, 32, target_sectors - 1)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        crate::layout::put_u64(&mut primary_header, 48, target_last_usable)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        primary_header[16..20].fill(0);
        let primary_crc = crate::layout::crc32(&primary_header[..92]);
        crate::layout::put_u32(&mut primary_header, 16, primary_crc)
            .map_err(|_| DeviceError::LayoutUnavailable)?;

        let backup_entries_lba = target_sectors - GPT_ARRAY_SECTORS - 1;
        let source_layout = layout;
        let source_entries_start =
            usize::try_from(source_layout.primary_entries_lba * SECTOR_BYTES)
                .map_err(|_| DeviceError::LayoutUnavailable)?;
        let entries = source
            .get(source_entries_start..source_entries_start + GPT_ARRAY_BYTES)
            .ok_or(DeviceError::LayoutUnavailable)?
            .to_vec();
        let backup_source_start = usize::try_from(source_layout.backup_entries_lba * SECTOR_BYTES)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        let backup_source_end = source.len();
        let mut backup_header = source
            .get(backup_source_end - SECTOR_BYTES as usize..)
            .ok_or(DeviceError::LayoutUnavailable)?
            .to_vec();
        crate::layout::put_u64(&mut backup_header, 24, target_sectors - 1)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        crate::layout::put_u64(&mut backup_header, 32, 1)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        crate::layout::put_u64(&mut backup_header, 40, 2048)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        crate::layout::put_u64(&mut backup_header, 48, target_last_usable)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        crate::layout::put_u64(&mut backup_header, 72, backup_entries_lba)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
        backup_header[16..20].fill(0);
        let backup_crc = crate::layout::crc32(&backup_header[..92]);
        crate::layout::put_u32(&mut backup_header, 16, backup_crc)
            .map_err(|_| DeviceError::LayoutUnavailable)?;

        let mut mbr = source
            .get(..SECTOR_BYTES as usize)
            .ok_or(DeviceError::LayoutUnavailable)?
            .to_vec();
        let mbr_size = (target_sectors - 1).min(u32::MAX as u64) as u32;
        mbr[458..462].copy_from_slice(&mbr_size.to_le_bytes());

        let mut new_head = source
            .get(..TABLE_WINDOW_BYTES)
            .ok_or(DeviceError::LayoutUnavailable)?
            .to_vec();
        new_head[..SECTOR_BYTES as usize].copy_from_slice(&mbr);
        new_head[SECTOR_BYTES as usize..(2 * SECTOR_BYTES) as usize]
            .copy_from_slice(&primary_header);
        let mut new_tail = vec![0; GPT_TRAILER_SECTORS as usize * 512];
        let tail_entries_at = 0;
        new_tail[tail_entries_at..tail_entries_at + GPT_ARRAY_BYTES].copy_from_slice(&entries);
        new_tail[GPT_ARRAY_BYTES..].copy_from_slice(&backup_header);
        let data_start = TABLE_WINDOW_BYTES as u64;
        let data_end = backup_source_start as u64;
        if data_end <= data_start {
            return Err(DeviceError::LayoutUnavailable);
        }
        let writes = vec![
            PlannedWrite {
                range: ByteRange {
                    start: data_start,
                    length: data_end - data_start,
                },
                source: WriteSource::Image { offset: data_start },
            },
            PlannedWrite {
                range: ByteRange {
                    start: 0,
                    length: TABLE_WINDOW_BYTES as u64,
                },
                source: WriteSource::Bytes(new_head),
            },
            PlannedWrite {
                range: ByteRange {
                    start: (target_sectors - GPT_TRAILER_SECTORS) * SECTOR_BYTES,
                    length: GPT_TRAILER_SECTORS * SECTOR_BYTES,
                },
                source: WriteSource::Bytes(new_tail),
            },
        ];
        for write in &writes {
            write.range.validate(&device)?;
        }
        let ranges = merge_ranges(writes.iter().map(|write| write.range).collect());
        Ok(Self {
            operation: WriteOperation::CreateLayout,
            device,
            source_digest: image.digest(),
            compressed_digest: image.compressed_digest(),
            release: image.selection().clone(),
            ranges,
            writes,
            remaining_bytes,
            phase_aware: true,
            exchange: None,
            identity: None,
        })
    }

    /// Personalise both GPT copies and boot menus, grow exchange and create
    /// an unformatted persistence partition with an empty header area.
    pub fn create_drive(
        image: &VerifiedImage,
        device: DeviceObservation,
    ) -> Result<Self, DeviceError> {
        Self::create_drive_with_identity(
            image,
            device,
            crate::drive_identity::DriveIdentity::fresh()?,
        )
    }

    pub fn create_drive_with_identity(
        image: &VerifiedImage,
        device: DeviceObservation,
        identity: crate::drive_identity::DriveIdentity,
    ) -> Result<Self, DeviceError> {
        identity.validate()?;
        let layout =
            LiveImageLayout::parse(image.bytes()).map_err(|_| DeviceError::LayoutUnavailable)?;
        let mut plan = Self::create_layout(image, device)?;
        let last_exclusive = plan.device.capacity_bytes / SECTOR_BYTES - GPT_TRAILER_SECTORS;
        let end = last_exclusive
            .checked_sub(crate::create::PERSIST_RESERVE_BYTES / SECTOR_BYTES)
            .ok_or(DeviceError::InsufficientCapacity)?
            / 2048
            * 2048;
        let start = layout.partitions[3].first_lba;
        let length = end
            .checked_sub(start)
            .ok_or(DeviceError::InsufficientCapacity)?
            * SECTOR_BYTES;
        if length < crate::create::EXCHANGE_HEADROOM_BYTES {
            return Err(DeviceError::InsufficientCapacity);
        }
        let exchange = ByteRange {
            start: start * SECTOR_BYTES,
            length,
        };
        exchange.validate(&plan.device)?;
        for (index, entries_at, header_at) in [
            (1, 2 * SECTOR_BYTES as usize, SECTOR_BYTES as usize),
            (2, 0, GPT_ARRAY_BYTES),
        ] {
            let WriteSource::Bytes(bytes) = &mut plan.writes[index].source else {
                return Err(DeviceError::LayoutUnavailable);
            };
            bytes[header_at + 56..header_at + 72]
                .copy_from_slice(&crate::drive_identity::gpt_guid(&identity.disk)?);
            for (partition, id) in identity.partitions.iter().enumerate() {
                let offset = entries_at + partition * 128;
                bytes[offset + 16..offset + 32]
                    .copy_from_slice(&crate::drive_identity::gpt_guid(id)?);
            }
            crate::layout::put_u64(bytes, entries_at + 3 * 128 + 40, end - 1)
                .map_err(|_| DeviceError::LayoutUnavailable)?;
            let p5 = entries_at + 4 * 128;
            bytes[p5..p5 + 16].copy_from_slice(&crate::drive_identity::gpt_guid(
                "ca7d7ccb-63ed-4c53-861c-1742536059cc",
            )?);
            crate::layout::put_u64(bytes, p5 + 32, end)
                .map_err(|_| DeviceError::LayoutUnavailable)?;
            crate::layout::put_u64(bytes, p5 + 40, last_exclusive - 1)
                .map_err(|_| DeviceError::LayoutUnavailable)?;
            for (index, word) in "AISPERSIST".encode_utf16().enumerate() {
                bytes[p5 + 56 + index * 2..p5 + 58 + index * 2]
                    .copy_from_slice(&word.to_le_bytes());
            }
            let crc = crate::layout::crc32(&bytes[entries_at..entries_at + GPT_ARRAY_BYTES]);
            crate::layout::put_u32(bytes, header_at + 88, crc)
                .map_err(|_| DeviceError::LayoutUnavailable)?;
            bytes[header_at + 16..header_at + 20].fill(0);
            let crc = crate::layout::crc32(&bytes[header_at..header_at + 92]);
            crate::layout::put_u32(bytes, header_at + 16, crc)
                .map_err(|_| DeviceError::LayoutUnavailable)?;
        }
        plan.remaining_bytes = (last_exclusive - end) * SECTOR_BYTES;
        let esp = &layout.partitions[1];
        let esp_start = (esp.first_lba * SECTOR_BYTES) as usize;
        let esp_end = ((esp.last_lba + 1) * SECTOR_BYTES) as usize;
        let original = image
            .bytes()
            .get(esp_start..esp_end)
            .ok_or(DeviceError::LayoutUnavailable)?;
        let patched = crate::drive_identity::patch_esp(original, &identity)?;
        // Bind only changed sectors, preserving all other ESP contents.
        for (sector, (before, after)) in original
            .as_chunks::<512>()
            .0
            .iter()
            .zip(patched.as_chunks::<512>().0)
            .enumerate()
        {
            if before != after {
                plan.writes.push(PlannedWrite {
                    range: ByteRange {
                        start: (esp_start + sector * 512) as u64,
                        length: 512,
                    },
                    source: WriteSource::Bytes(after.to_vec()),
                });
            }
        }
        let persist = ByteRange {
            start: end * SECTOR_BYTES,
            // First boot only requires an empty 16 MiB header area before creating LUKS.
            length: 16 * 1024 * 1024,
        };
        persist.validate(&plan.device)?;
        plan.writes.push(PlannedWrite {
            range: persist,
            source: WriteSource::Zeroes,
        });
        plan.ranges.push(persist);
        plan.identity = Some(identity);
        plan.ranges.push(exchange);
        plan.ranges = merge_ranges(plan.ranges);
        plan.exchange = Some(exchange);
        Ok(plan)
    }

    /// Replace only p3, p1 and the personalised p2. GPT, exchange and persist
    /// are outside every raw write range, including on a partial failure.
    pub fn update_drive(
        image: &VerifiedImage,
        snapshot: &crate::update::DriveSnapshot,
        installed: &crate::update::InstalledImage,
    ) -> Result<Self, DeviceError> {
        installed.require_newer(image)?;
        let parts = snapshot.partitions(&installed.identity)?;
        let source =
            LiveImageLayout::parse(image.bytes()).map_err(|_| DeviceError::LayoutUnavailable)?;
        // The MBR is preserved, so a release requiring different BIOS bootstrap code cannot fit this update.
        if snapshot.head[..440] != image.bytes()[..440] {
            return Err(DeviceError::LayoutUnavailable);
        }
        for (index, (old, new)) in parts.iter().zip(&source.partitions).enumerate() {
            if old.type_guid != new.type_guid
                || old.attributes != new.attributes
                || (index < 3 && old.first_lba != new.first_lba)
                || (index < 2 && old.last_lba != new.last_lba)
                || (index == 2 && new.last_lba > old.last_lba)
            {
                return Err(DeviceError::LayoutUnavailable);
            }
        }
        let mut writes = Vec::new();
        for index in [2, 0, 1] {
            let range = crate::update::partition_range(&source.partitions[index]);
            range.validate(&snapshot.observation)?;
            let data = if index == 1 {
                let bytes =
                    &image.bytes()[range.start as usize..(range.start + range.length) as usize];
                WriteSource::Bytes(crate::drive_identity::patch_esp(
                    bytes,
                    &installed.identity,
                )?)
            } else {
                WriteSource::Image {
                    offset: range.start,
                }
            };
            writes.push(PlannedWrite {
                range,
                source: data,
            });
        }
        Ok(Self {
            operation: WriteOperation::ReplaceBase,
            device: snapshot.observation.clone(),
            source_digest: image.digest(),
            compressed_digest: image.compressed_digest(),
            release: image.selection().clone(),
            ranges: merge_ranges(writes.iter().map(|write| write.range).collect()),
            writes,
            remaining_bytes: crate::update::partition_range(&parts[4]).length,
            phase_aware: true,
            exchange: Some(crate::update::partition_range(&parts[3])),
            identity: Some(installed.identity.clone()),
        })
    }

    pub fn exchange_range(&self) -> Option<ByteRange> {
        self.exchange
    }

    /// Check the final GPT and the original physical/mount identity before any
    /// additional exchange metadata writes through the retained target.
    pub fn verify_created_layout(&self, target: &mut impl WriteTarget) -> Result<(), DeviceError> {
        let current = target.observe().map_err(|_| DeviceError::Changed)?;
        if self.exchange.is_none() || !observation_stable(self, &current) {
            return Err(DeviceError::Changed);
        }
        let (WriteSource::Bytes(head), WriteSource::Bytes(tail)) =
            (&self.writes[1].source, &self.writes[2].source)
        else {
            return Err(DeviceError::LayoutUnavailable);
        };
        let (_, mut expected_tail) =
            read_table_windows(target, &current).map_err(|_| DeviceError::Changed)?;
        expected_tail[512..].copy_from_slice(tail);
        verify_expected_table(
            target,
            &current,
            &ExpectedTable {
                head: head.clone(),
                tail: expected_tail,
            },
        )
    }

    /// Read back both boot menus between GPT and physical identity checks.
    /// This full ESP read is needed at phase boundaries, not for each p4 chunk.
    pub fn verify_created_target(&self, target: &mut impl WriteTarget) -> Result<(), DeviceError> {
        self.verify_created_layout(target)?;
        let WriteSource::Bytes(head) = &self.writes[1].source else {
            return Err(DeviceError::LayoutUnavailable);
        };
        let identity = self
            .identity
            .as_ref()
            .ok_or(DeviceError::LayoutUnavailable)?;
        let p2 = 1024 + 128;
        let first = u64::from_le_bytes(head[p2 + 32..p2 + 40].try_into().unwrap());
        let last = u64::from_le_bytes(head[p2 + 40..p2 + 48].try_into().unwrap());
        let mut esp = vec![0; ((last - first + 1) * SECTOR_BYTES) as usize];
        target
            .read_at(first * SECTOR_BYTES, &mut esp)
            .map_err(|_| DeviceError::Changed)?;
        crate::drive_identity::verify_esp(&esp, identity)?;
        self.verify_created_layout(target)
    }

    /// Regular-file harness only. It does not claim to create a bootable layout.
    #[cfg(feature = "file-test")]
    pub fn synthetic_image(
        image: &VerifiedImage,
        device: DeviceObservation,
    ) -> Result<Self, DeviceError> {
        device.validate()?;
        let range = ByteRange {
            start: 0,
            length: image.len(),
        };
        range.validate(&device)?;
        Ok(Self {
            operation: WriteOperation::CreateLayout,
            device,
            source_digest: image.digest(),
            compressed_digest: image.compressed_digest(),
            release: image.selection().clone(),
            ranges: vec![range],
            writes: vec![PlannedWrite {
                range,
                source: WriteSource::Image { offset: 0 },
            }],
            remaining_bytes: 0,
            phase_aware: false,
            exchange: None,
            identity: Some(crate::drive_identity::DriveIdentity::fresh()?),
        })
    }

    pub fn device(&self) -> &DeviceObservation {
        &self.device
    }
    pub fn identity(&self) -> Option<&crate::drive_identity::DriveIdentity> {
        self.identity.as_ref()
    }
    pub fn ranges(&self) -> &[ByteRange] {
        &self.ranges
    }
    pub fn operation(&self) -> WriteOperation {
        self.operation
    }
    /// Capacity after p4, assigned to the empty persistence partition on creation.
    pub fn remaining_bytes(&self) -> u64 {
        self.remaining_bytes
    }
    pub fn digest(&self) -> [u8; 32] {
        // Only fixed struct fields, ordered vectors and integer values are encoded.
        sha256(&serde_json::to_vec(self).expect("write plans contain only JSON-safe values"))
    }
    pub fn revalidate(
        &self,
        current: &DeviceObservation,
        image: &VerifiedImage,
    ) -> Result<(), DeviceError> {
        current.validate()?;
        if current != &self.device {
            return Err(DeviceError::Changed);
        }
        if image.digest() != self.source_digest
            || image.compressed_digest() != self.compressed_digest
            || image.selection() != &self.release
            || self.writes.is_empty()
        {
            return Err(DeviceError::Changed);
        }
        for range in &self.ranges {
            range.validate(current)?;
        }
        for write in &self.writes {
            let expected_len = match &write.source {
                WriteSource::Image { offset } => offset
                    .checked_add(write.range.length)
                    .is_some_and(|end| end <= image.len()),
                WriteSource::Bytes(bytes) => bytes.len() as u64 == write.range.length,
                WriteSource::Zeroes => true,
            };
            if !expected_len {
                return Err(DeviceError::Changed);
            }
        }
        Ok(())
    }
}

fn merge_ranges(mut ranges: Vec<ByteRange>) -> Vec<ByteRange> {
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<ByteRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        let end = range.start.saturating_add(range.length);
        if let Some(last) = merged.last_mut() {
            let last_end = last.start.saturating_add(last.length);
            if range.start <= last_end {
                last.length = last_end.max(end).saturating_sub(last.start);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

#[cfg(all(test, feature = "file-test"))]
mod tests {
    use super::*;
    use crate::{file_test::SyntheticRelease, layout::synthetic_sfdisk_contract_fixture};

    #[test]
    fn create_layout_relocates_backup_gpt_and_preserves_boot_code_and_legacy_attribute() {
        let raw = synthetic_sfdisk_contract_fixture();
        let fixture = SyntheticRelease::new(raw.clone());
        let (_, image) = fixture
            .verify_live_layout(&std::env::temp_dir())
            .expect("synthetic signed B layout verifies");
        let capacity = image.len() + 8 * 1024 * 1024;
        let observation = DeviceObservation {
            os_identity: "SYNTHETIC_FIXTURE_OS_ID".into(),
            connection_identity: "SYNTHETIC_FIXTURE_CONNECTION".into(),
            display_identifier: "SYNTHETIC_FIXTURE_DISK".into(),
            serial: Some("SYNTHETIC_FIXTURE_SERIAL".into()),
            model: Some("SYNTHETIC_FIXTURE_MODEL".into()),
            capacity_bytes: capacity,
            sector_bytes: 512,
            table_fingerprint: table_fingerprint(
                &vec![0; TABLE_WINDOW_BYTES],
                &vec![0; TABLE_WINDOW_BYTES],
            )
            .unwrap(),
            ancestry_fingerprint: sha256(b"SYNTHETIC_FIXTURE_ANCESTRY"),
            mount_fingerprint: sha256(b"SYNTHETIC_FIXTURE_MOUNTS"),
            external_usb: true,
            internal: false,
            system_backing: false,
            ancestry_complete: true,
            writable: true,
        };
        let plan = WritePlan::create_layout(&image, observation).unwrap();
        assert_eq!(plan.operation, WriteOperation::CreateLayout);
        assert_eq!(plan.ranges.len(), 2);
        assert_eq!(plan.ranges[0].start, 0);
        assert!(plan.remaining_bytes > 0);

        let WriteSource::Bytes(head) = &plan.writes[1].source else {
            panic!("primary table range must contain planned transition bytes");
        };
        assert_eq!(&head[..440], &raw[..440]);
        let p2_attribute = u64::from_le_bytes(
            head[2 * 512 + 128 + 48..2 * 512 + 128 + 56]
                .try_into()
                .unwrap(),
        );
        assert_eq!(p2_attribute, 1 << 2);
        let target_sectors = capacity / SECTOR_BYTES;
        assert_eq!(
            u64::from_le_bytes(head[512 + 32..512 + 40].try_into().unwrap()),
            target_sectors - 1
        );
        assert_eq!(
            u64::from_le_bytes(head[512 + 48..512 + 56].try_into().unwrap()),
            target_sectors - 34
        );

        let WriteSource::Bytes(tail) = &plan.writes[2].source else {
            panic!("backup table range must contain planned transition bytes");
        };
        assert_eq!(tail.len(), GPT_ARRAY_BYTES + 512);
        let backup_header = &tail[GPT_ARRAY_BYTES..];
        assert_eq!(
            u64::from_le_bytes(backup_header[24..32].try_into().unwrap()),
            target_sectors - 1
        );
        assert_eq!(
            u64::from_le_bytes(backup_header[72..80].try_into().unwrap()),
            target_sectors - 33
        );
        let stored_crc = u32::from_le_bytes(backup_header[16..20].try_into().unwrap());
        let mut crc_bytes = backup_header[..92].to_vec();
        crc_bytes[16..20].fill(0);
        assert_eq!(stored_crc, crate::layout::crc32(&crc_bytes));
        let mut plan = plan;
        let original_digest = plan.digest();
        let WriteSource::Bytes(head) = &mut plan.writes[1].source else {
            unreachable!();
        };
        head[0] ^= 1;
        assert_ne!(
            original_digest,
            plan.digest(),
            "replacement bytes are bound"
        );
    }
}

pub struct ConfirmationTicket {
    nonce: [u8; 32],
}
struct Approval {
    plan: [u8; 32],
    identifier: String,
    expires: Instant,
}

struct ApprovalPermit {
    plan: [u8; 32],
    identifier: String,
    expires: Instant,
}

impl ApprovalPermit {
    fn validate_before_mutation(
        &self,
        plan: &WritePlan,
        current: &DeviceObservation,
        image: &VerifiedImage,
        now: Instant,
    ) -> Result<(), DeviceError> {
        if now >= self.expires
            || self.plan != plan.digest()
            || self.identifier != current.display_identifier
        {
            return Err(DeviceError::Stale);
        }
        plan.revalidate(current, image)
    }
}

/// Keep one book per app session. Refreshes and changed choices call invalidate.
#[derive(Default)]
pub struct ConfirmationBook {
    approvals: BTreeMap<[u8; 32], Approval>,
}

impl ConfirmationBook {
    pub fn invalidate(&mut self) {
        self.approvals.clear();
    }

    pub fn issue(
        &mut self,
        plan: &WritePlan,
        typed: &str,
        now: Instant,
        ttl: Duration,
    ) -> Result<ConfirmationTicket, DeviceError> {
        // A new attempt invalidates previous approvals, including a wrong attempt.
        self.invalidate();
        if typed != plan.device.display_identifier || typed.is_empty() {
            return Err(DeviceError::Confirmation);
        }
        if ttl.is_zero() || ttl > Duration::from_secs(120) {
            return Err(DeviceError::Stale);
        }
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| DeviceError::Entropy)?;
        self.approvals.insert(
            nonce,
            Approval {
                plan: plan.digest(),
                identifier: typed.to_owned(),
                expires: now + ttl,
            },
        );
        Ok(ConfirmationTicket { nonce })
    }

    pub fn consume(
        &mut self,
        ticket: &ConfirmationTicket,
        plan: &WritePlan,
        current: &DeviceObservation,
        image: &VerifiedImage,
        now: Instant,
    ) -> Result<(), DeviceError> {
        let permit = self.reserve(ticket, plan, now)?;
        permit.validate_before_mutation(plan, current, image, now)
    }

    fn reserve(
        &mut self,
        ticket: &ConfirmationTicket,
        plan: &WritePlan,
        now: Instant,
    ) -> Result<ApprovalPermit, DeviceError> {
        // Remove before checking, so every refused attempt consumes approval.
        let approval = self
            .approvals
            .remove(&ticket.nonce)
            .ok_or(DeviceError::Stale)?;
        if now >= approval.expires || approval.plan != plan.digest() {
            return Err(DeviceError::Stale);
        }
        Ok(ApprovalPermit {
            plan: approval.plan,
            identifier: approval.identifier,
            expires: approval.expires,
        })
    }
}

/// All platform writes remain unavailable until their native evidence is supplied.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSupport {
    pub enabled: bool,
    pub reason: &'static str,
}

pub fn write_support() -> WriteSupport {
    WriteSupport {
        enabled: false,
        reason: "The reviewed image trust anchor and native helper authorisation are unavailable in this build.",
    }
}

/// Implementations own an already-open handle. No writer takes a target path.
pub trait WriteTarget: std::io::Read + std::io::Write + std::io::Seek {
    fn observe(&self) -> std::io::Result<DeviceObservation>;
    fn lock_exclusive(&mut self) -> std::io::Result<()>;
    fn flush_durable(&mut self) -> std::io::Result<()>;

    /// Positional read used for bounded partition-table rechecks. Native
    /// implementations should use pread/ReadFile-at-offset so it cannot move
    /// the writer cursor. The default exists for regular-file test targets.
    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
        let position = self.stream_position()?;
        self.seek(std::io::SeekFrom::Start(offset))?;
        let result = std::io::Read::read_exact(self, buffer);
        let restore = self.seek(std::io::SeekFrom::Start(position));
        result.and(restore.map(|_| ()))
    }
}

/// Lets a caller keep the handle, for example to read a loop file back.
impl<T: WriteTarget> WriteTarget for &mut T {
    fn observe(&self) -> std::io::Result<DeviceObservation> {
        (**self).observe()
    }
    fn lock_exclusive(&mut self) -> std::io::Result<()> {
        (**self).lock_exclusive()
    }
    fn flush_durable(&mut self) -> std::io::Result<()> {
        (**self).flush_durable()
    }
    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
        (**self).read_at(offset, buffer)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum WriteFailure {
    Refused(&'static str),
    /// Confirmed bytes are a lower bound, not a claim that other bytes are intact.
    Incomplete {
        confirmed_bytes: u64,
        reason: &'static str,
    },
}

/// Callers own the OS-authorised channel and operation lock. This routine is the
/// shared bounded byte writer, not an elevation or device-discovery mechanism.
pub fn write_image(
    target: &mut impl WriteTarget,
    image: &mut VerifiedImage,
    plan: &WritePlan,
    approvals: &mut ConfirmationBook,
    ticket: &ConfirmationTicket,
    mut cancelled: impl FnMut() -> bool,
) -> Result<u64, WriteFailure> {
    use std::io::SeekFrom;
    // Reserve immediately so every failure from this point consumes the
    // single-use approval. Expiry is checked again at the mutation boundary.
    let permit = approvals
        .reserve(ticket, plan, Instant::now())
        .map_err(|_| WriteFailure::Refused("confirmation"))?;
    if cancelled() {
        return Err(WriteFailure::Refused("cancelled"));
    }
    image
        .revalidate_source()
        .map_err(|_| WriteFailure::Refused("image source changed"))?;
    target
        .lock_exclusive()
        .map_err(|_| WriteFailure::Refused("exclusive access"))?;
    let current = target
        .observe()
        .map_err(|_| WriteFailure::Refused("device observation"))?;
    plan.revalidate(&current, image)
        .map_err(|_| WriteFailure::Refused("device changed"))?;
    let mut expected_table = if plan.phase_aware {
        let (head, tail) = read_table_windows(target, &current)
            .map_err(|_| WriteFailure::Refused("partition table read"))?;
        let observed = table_fingerprint(&head, &tail)
            .map_err(|_| WriteFailure::Refused("partition table read"))?;
        if observed != plan.device.table_fingerprint || current.table_fingerprint != observed {
            return Err(WriteFailure::Refused("partition table changed"));
        }
        Some(ExpectedTable { head, tail })
    } else {
        None
    };
    if cancelled() {
        return Err(WriteFailure::Refused("cancelled"));
    }
    let mut written = 0_u64;
    let budget = Instant::now();
    let failure = |written, reason| {
        if written == 0 {
            WriteFailure::Refused(reason)
        } else {
            WriteFailure::Incomplete {
                confirmed_bytes: written,
                reason,
            }
        }
    };
    for write in &plan.writes {
        // Hash the retained source before borrowing its decoded bytes. The final
        // device observation and table check happen at the mutation boundary.
        if written == 0 {
            image
                .revalidate_source()
                .map_err(|_| failure(written, "image source changed"))?;
        }
        let expected_bytes: &[u8] = match &write.source {
            WriteSource::Image { offset } => {
                let start =
                    usize::try_from(*offset).map_err(|_| failure(written, "source bounds"))?;
                let end = start
                    .checked_add(write.range.length as usize)
                    .ok_or_else(|| failure(written, "source bounds"))?;
                image
                    .bytes()
                    .get(start..end)
                    .ok_or_else(|| failure(written, "source bounds"))?
            }
            WriteSource::Bytes(bytes) => bytes,
            WriteSource::Zeroes => &[],
        };
        let zeroes = [0u8; 64 * 1024];
        let chunks = || {
            (0..write.range.length).step_by(zeroes.len()).map(|offset| {
                let length = (write.range.length - offset).min(zeroes.len() as u64) as usize;
                if matches!(write.source, WriteSource::Zeroes) {
                    &zeroes[..length]
                } else {
                    &expected_bytes[offset as usize..offset as usize + length]
                }
            })
        };
        target
            .seek(SeekFrom::Start(write.range.start))
            .map_err(|_| failure(written, "seek"))?;
        for (chunk_index, chunk) in chunks().enumerate() {
            if cancelled() || budget.elapsed() >= Duration::from_secs(600) {
                let _ = target.flush_durable();
                return Err(failure(written, "cancelled or timed out"));
            }
            let current = target
                .observe()
                .map_err(|_| failure(written, "device disconnected"))?;
            if !observation_stable(plan, &current) {
                return Err(failure(written, "device changed"));
            }
            if let Some(expected) = expected_table.as_ref() {
                verify_expected_table(target, &current, expected)
                    .map_err(|_| failure(written, "partition table changed"))?;
            }
            let mut remaining = chunk;
            let mut chunk_offset = write
                .range
                .start
                .checked_add((chunk_index * 64 * 1024) as u64)
                .ok_or_else(|| failure(written, "write bounds"))?;
            while !remaining.is_empty() {
                if cancelled() || budget.elapsed() >= Duration::from_secs(600) {
                    let _ = target.flush_durable();
                    return Err(failure(written, "cancelled or timed out"));
                }
                if written == 0 {
                    let current = target
                        .observe()
                        .map_err(|_| failure(written, "device disconnected"))?;
                    if !observation_stable(plan, &current) {
                        return Err(failure(written, "device changed"));
                    }
                    if let Some(expected) = expected_table.as_ref() {
                        verify_expected_table(target, &current, expected)
                            .map_err(|_| failure(written, "partition table changed"))?;
                    }
                    permit
                        .validate_before_mutation(plan, &current, image, Instant::now())
                        .map_err(|_| failure(written, "confirmation"))?;
                }
                match target.write(remaining) {
                    Ok(0) => return Err(failure(written, "zero-length write")),
                    Ok(count) if count <= remaining.len() => {
                        if let Some(expected) = expected_table.as_mut() {
                            let data = &remaining[..count];
                            expected.overlay(chunk_offset, data, current.capacity_bytes);
                        }
                        written += count as u64;
                        chunk_offset += count as u64;
                        remaining = &remaining[count..];
                    }
                    Ok(_) => return Err(failure(written, "invalid write result")),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(failure(written, "write failed")),
                }
            }
            let current = target
                .observe()
                .map_err(|_| failure(written, "device disconnected"))?;
            if !observation_stable(plan, &current) {
                return Err(failure(written, "device changed"));
            }
            if let Some(expected) = expected_table.as_ref() {
                verify_expected_table(target, &current, expected)
                    .map_err(|_| failure(written, "partition table changed"))?;
            }
        }
        target
            .flush_durable()
            .map_err(|_| failure(written, "flush failed"))?;
        target
            .seek(SeekFrom::Start(write.range.start))
            .map_err(|_| failure(written, "readback seek"))?;
        let mut readback = [0; 64 * 1024];
        for expected in chunks() {
            if cancelled() || budget.elapsed() >= Duration::from_secs(600) {
                return Err(failure(written, "readback cancelled or timed out"));
            }
            target
                .read_exact(&mut readback[..expected.len()])
                .map_err(|_| failure(written, "readback failed"))?;
            if readback[..expected.len()] != *expected {
                return Err(failure(written, "readback mismatch"));
            }
        }
    }
    image
        .revalidate_source()
        .map_err(|_| failure(written, "image source changed"))?;
    let current = target
        .observe()
        .map_err(|_| failure(written, "device disconnected"))?;
    if !observation_stable(plan, &current) {
        return Err(failure(written, "device changed"));
    }
    if let Some(expected) = expected_table.as_ref() {
        verify_expected_table(target, &current, expected)
            .map_err(|_| failure(written, "partition table changed"))?;
    }
    Ok(written)
}

struct ExpectedTable {
    head: Vec<u8>,
    tail: Vec<u8>,
}

impl ExpectedTable {
    fn overlay(&mut self, offset: u64, bytes: &[u8], capacity: u64) {
        overlay_window(&mut self.head, 0, offset, bytes);
        let tail_start = capacity.saturating_sub(TABLE_WINDOW_BYTES as u64);
        overlay_window(&mut self.tail, tail_start, offset, bytes);
    }
}

fn overlay_window(window: &mut [u8], window_start: u64, offset: u64, bytes: &[u8]) {
    let Some(write_end) = offset.checked_add(bytes.len() as u64) else {
        return;
    };
    let Some(window_end) = window_start.checked_add(window.len() as u64) else {
        return;
    };
    let start = offset.max(window_start);
    let end = write_end.min(window_end);
    if start >= end {
        return;
    }
    let dst_start = (start - window_start) as usize;
    let src_start = (start - offset) as usize;
    let count = (end - start) as usize;
    window[dst_start..dst_start + count].copy_from_slice(&bytes[src_start..src_start + count]);
}

fn observation_stable(plan: &WritePlan, current: &DeviceObservation) -> bool {
    plan.device.same_physical_identity(current)
        && current.validate().is_ok()
        && current.mount_fingerprint == plan.device.mount_fingerprint
}

fn read_table_windows(
    target: &mut impl WriteTarget,
    current: &DeviceObservation,
) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    if current.capacity_bytes < (TABLE_WINDOW_BYTES as u64) * 2 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "device is smaller than bounded table windows",
        ));
    }
    let mut head = vec![0; TABLE_WINDOW_BYTES];
    let mut tail = vec![0; TABLE_WINDOW_BYTES];
    target.read_at(0, &mut head)?;
    target.read_at(
        current.capacity_bytes - TABLE_WINDOW_BYTES as u64,
        &mut tail,
    )?;
    Ok((head, tail))
}

fn verify_expected_table(
    target: &mut impl WriteTarget,
    current: &DeviceObservation,
    expected: &ExpectedTable,
) -> Result<(), DeviceError> {
    let (head, tail) = read_table_windows(target, current).map_err(|_| DeviceError::Changed)?;
    let actual = table_fingerprint(&head, &tail)?;
    let expected_fingerprint = table_fingerprint(&expected.head, &expected.tail)?;
    if actual != expected_fingerprint || actual != current.table_fingerprint {
        return Err(DeviceError::Changed);
    }
    Ok(())
}
