//! Update planning accepts only an observed personalised GPT and a newer verified release.
use crate::{
    device::{ByteRange, DeviceError, DeviceObservation, TABLE_WINDOW_BYTES, table_fingerprint},
    drive_identity::{DriveIdentity, gpt_guid},
    layout::{self, GPT_ARRAY_BYTES, Partition, SECTOR_BYTES},
    release::{VerifiedImage, hex, sha256},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledImage {
    pub identity: DriveIdentity,
    pub release_order: (u64, u64),
    pub tag: String,
    pub image_digest: [u8; 32],
    pub hardware_hint: String,
}
impl InstalledImage {
    pub fn new(image: &VerifiedImage, identity: DriveIdentity, device: &DeviceObservation) -> Self {
        Self {
            identity,
            release_order: image.selection().order(),
            tag: image.selection().tag().into(),
            image_digest: image.digest(),
            hardware_hint: hardware_hint(device),
        }
    }
    pub fn validate(&self) -> Result<(), DeviceError> {
        self.identity.validate()?;
        if self.release_order.0 == 0
            || self.release_order.1 == 0
            || !crate::release::valid_live_tag(&self.tag)
            || self.hardware_hint.len() != 64
            || !self.hardware_hint.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(DeviceError::LayoutUnavailable);
        }
        Ok(())
    }
    pub fn require_newer(&self, image: &VerifiedImage) -> Result<(), DeviceError> {
        self.validate()?;
        if image.selection().order() <= self.release_order
            || image.selection().tag() == self.tag
            || image.digest() == self.image_digest
        {
            return Err(DeviceError::LayoutUnavailable);
        }
        Ok(())
    }
}
pub fn hardware_hint(device: &DeviceObservation) -> String {
    hex(&sha256(
        &serde_json::to_vec(&(
            device.serial.as_deref(),
            device.model.as_deref(),
            device.capacity_bytes,
        ))
        .expect("serialisable hardware hint"),
    ))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriveSnapshot {
    pub observation: DeviceObservation,
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
}
impl DriveSnapshot {
    pub fn read(
        observation: DeviceObservation,
        mut read: impl FnMut(u64, &mut [u8]) -> std::io::Result<()>,
    ) -> Result<Self, DeviceError> {
        observation.validate()?;
        let mut head = vec![0; TABLE_WINDOW_BYTES];
        let mut tail = vec![0; TABLE_WINDOW_BYTES];
        let offset = observation
            .capacity_bytes
            .checked_sub(TABLE_WINDOW_BYTES as u64)
            .ok_or(DeviceError::Bounds)?;
        read(0, &mut head).map_err(|_| DeviceError::Changed)?;
        read(offset, &mut tail).map_err(|_| DeviceError::Changed)?;
        if table_fingerprint(&head, &tail)? != observation.table_fingerprint {
            return Err(DeviceError::Changed);
        }
        Ok(Self {
            observation,
            head,
            tail,
        })
    }
    pub fn partitions(&self, identity: &DriveIdentity) -> Result<[Partition; 5], DeviceError> {
        self.parse(identity)
            .map_err(|_| DeviceError::LayoutUnavailable)
    }
    fn parse(
        &self,
        identity: &DriveIdentity,
    ) -> Result<[Partition; 5], crate::release::TrustError> {
        use crate::release::TrustError::Layout;
        identity.validate().map_err(|_| Layout)?;
        self.observation.validate().map_err(|_| Layout)?;
        if self.observation.sector_bytes != SECTOR_BYTES as u32
            || self.head.len() != TABLE_WINDOW_BYTES
            || self.tail.len() != TABLE_WINDOW_BYTES
            || table_fingerprint(&self.head, &self.tail).map_err(|_| Layout)?
                != self.observation.table_fingerprint
        {
            return Err(Layout);
        }
        let sectors = self.observation.capacity_bytes / SECTOR_BYTES;
        if sectors < 4096 {
            return Err(Layout);
        }
        layout::validate_mbr(&self.head, sectors)?;
        let primary = layout::parse_header_sector(&self.head[512..1024], sectors)?;
        let backup = layout::parse_header_sector(&self.tail[TABLE_WINDOW_BYTES - 512..], sectors)?;
        let entries = &self.head[1024..1024 + GPT_ARRAY_BYTES];
        if primary.current_lba != 1
            || primary.backup_lba != sectors - 1
            || backup.current_lba != sectors - 1
            || backup.backup_lba != 1
            || primary.first_usable != 2048
            || backup.first_usable != 2048
            || primary.last_usable != sectors - 34
            || backup.last_usable != sectors - 34
            || primary.entries_lba != 2
            || backup.entries_lba != sectors - 33
            || primary.entry_count != 128
            || backup.entry_count != 128
            || primary.entry_size != 128
            || backup.entry_size != 128
            || primary.disk_guid != backup.disk_guid
            || primary.disk_guid != gpt_guid(&identity.disk).map_err(|_| Layout)?
            || primary.entries_crc != backup.entries_crc
            || layout::crc32(entries) != primary.entries_crc
            || entries != &self.tail[512..512 + GPT_ARRAY_BYTES]
            || entries[5 * 128..].iter().any(|b| *b != 0)
        {
            return Err(Layout);
        }
        let parts = [
            layout::parse_partition(entries, 0, "BIOS")?,
            layout::parse_partition(entries, 1, "AISBOOT")?,
            layout::parse_partition(entries, 2, "AISBASE")?,
            layout::parse_partition(entries, 3, "AISX")?,
            layout::parse_partition(entries, 4, "AISPERSIST")?,
        ];
        for (part, id) in parts.iter().zip(&identity.partitions) {
            if part.unique_guid != gpt_guid(id).map_err(|_| Layout)?
                || part.first_lba < 2048
                || part.last_lba > sectors - 34
            {
                return Err(Layout);
            }
        }
        for pair in parts.windows(2) {
            if pair[0].last_lba.checked_add(1) != Some(pair[1].first_lba) {
                return Err(Layout);
            }
        }
        if parts[0].first_lba != 2048
            || parts[0].last_lba != 4095
            || parts[1].first_lba != 4096
            || parts[4].last_lba != sectors - 34
            || parts[4].type_guid
                != gpt_guid("ca7d7ccb-63ed-4c53-861c-1742536059cc").map_err(|_| Layout)?
            || parts[4].attributes != 0
            || parts[4].last_lba - parts[4].first_lba + 1 < 32768
        {
            return Err(Layout);
        }
        Ok(parts)
    }
}
pub fn partition_range(part: &Partition) -> ByteRange {
    ByteRange {
        start: part.first_lba * SECTOR_BYTES,
        length: (part.last_lba - part.first_lba + 1) * SECTOR_BYTES,
    }
}
