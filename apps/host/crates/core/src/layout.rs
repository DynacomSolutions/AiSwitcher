//! Parser for the production raw GPT image emitted by B's `assemble.sh`.
//! The parser deliberately validates the bytes and geometry, not partition labels alone.
use crate::release::{MAX_IMAGE_BYTES, TrustError};

pub const SECTOR_BYTES: u64 = 512;
pub const GPT_ENTRY_COUNT: usize = 128;
pub const GPT_ENTRY_BYTES: usize = 128;
pub const GPT_ARRAY_BYTES: usize = GPT_ENTRY_COUNT * GPT_ENTRY_BYTES;
pub const GPT_ARRAY_SECTORS: u64 = (GPT_ARRAY_BYTES as u64).div_ceil(SECTOR_BYTES);
pub const GPT_TRAILER_SECTORS: u64 = GPT_ARRAY_SECTORS + 1;
pub const MIN_UNALLOCATED_BYTES: u64 = 1024 * 1024;
pub const MIN_BASE_PARTITION_MIB: u64 = 65;

const BIOS_BOOT: [u8; 16] = [
    0x48, 0x61, 0x68, 0x21, 0x49, 0x64, 0x6f, 0x6e, 0x74, 0x4e, 0x65, 0x65, 0x64, 0x45, 0x46, 0x49,
];
const EFI_SYSTEM: [u8; 16] = [
    0x28, 0x73, 0x2a, 0xc1, 0x1f, 0x81, 0xd2, 0x11, 0xba, 0x4b, 0x00, 0xa0, 0xc9, 0x3e, 0xc9, 0x3b,
];
const LINUX_FILESYSTEM: [u8; 16] = [
    0xaf, 0x3d, 0xc6, 0x0f, 0x83, 0x84, 0x72, 0x47, 0x8e, 0x79, 0x3d, 0x69, 0xd8, 0x47, 0x7d, 0xe4,
];
const BASIC_DATA: [u8; 16] = [
    0xa2, 0xa0, 0xd0, 0xeb, 0xe5, 0xb9, 0x33, 0x44, 0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7,
];
const LEGACY_BIOS_BOOTABLE: u64 = 1 << 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Partition {
    pub number: u8,
    pub first_lba: u64,
    pub last_lba: u64,
    pub type_guid: [u8; 16],
    pub unique_guid: [u8; 16],
    pub attributes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveImageLayout {
    pub image_sectors: u64,
    pub partitions: [Partition; 4],
    pub gpt_disk_guid: [u8; 16],
    pub primary_entries_lba: u64,
    pub backup_entries_lba: u64,
}

impl LiveImageLayout {
    pub fn parse(bytes: &[u8]) -> Result<Self, TrustError> {
        if bytes.is_empty()
            || bytes.len() as u64 >= MAX_IMAGE_BYTES
            || !(bytes.len() as u64).is_multiple_of(SECTOR_BYTES)
            || bytes.len() < (4096 * SECTOR_BYTES) as usize
        {
            return Err(TrustError::Layout);
        }
        let sectors = bytes.len() as u64 / SECTOR_BYTES;
        validate_mbr(bytes, sectors)?;
        let primary = parse_header(bytes, 1, sectors)?;
        let backup = parse_header(bytes, sectors - 1, sectors)?;
        if primary.current_lba != 1
            || primary.backup_lba != sectors - 1
            || backup.current_lba != sectors - 1
            || backup.backup_lba != 1
            // B's sfdisk layout reserves the first MiB as well as the GPT
            // metadata, so the first usable LBA is the start of p1.
            || primary.first_usable != 2048
            || primary.last_usable != sectors - 34
            || backup.first_usable != primary.first_usable
            || backup.last_usable != primary.last_usable
            || primary.disk_guid == [0; 16]
            || primary.disk_guid != backup.disk_guid
            || primary.entries_lba != 2
            || backup.entries_lba != sectors - GPT_TRAILER_SECTORS
            || primary.entry_count != GPT_ENTRY_COUNT as u32
            || backup.entry_count != GPT_ENTRY_COUNT as u32
            || primary.entry_size != GPT_ENTRY_BYTES as u32
            || backup.entry_size != GPT_ENTRY_BYTES as u32
            || primary.entries_crc != backup.entries_crc
        {
            return Err(TrustError::Layout);
        }
        let entries_start = (primary.entries_lba * SECTOR_BYTES) as usize;
        let entries = bytes
            .get(entries_start..entries_start + GPT_ARRAY_BYTES)
            .ok_or(TrustError::Layout)?;
        if crc32(entries) != primary.entries_crc {
            return Err(TrustError::Layout);
        }
        let backup_start = (backup.entries_lba * SECTOR_BYTES) as usize;
        let backup_entries = bytes
            .get(backup_start..backup_start + GPT_ARRAY_BYTES)
            .ok_or(TrustError::Layout)?;
        if entries != backup_entries {
            return Err(TrustError::Layout);
        }
        let partitions = [
            parse_partition(entries, 0, "BIOS")?,
            parse_partition(entries, 1, "AISBOOT")?,
            parse_partition(entries, 2, "AISBASE")?,
            parse_partition(entries, 3, "AISX")?,
        ];
        if entries[4 * GPT_ENTRY_BYTES..].iter().any(|byte| *byte != 0) {
            return Err(TrustError::Layout);
        }
        validate_partitions(&partitions, sectors)?;
        Ok(Self {
            image_sectors: sectors,
            partitions,
            gpt_disk_guid: primary.disk_guid,
            primary_entries_lba: primary.entries_lba,
            backup_entries_lba: backup.entries_lba,
        })
    }

    pub fn p4_end_lba(&self) -> u64 {
        self.partitions[3].last_lba + 1
    }
}

struct Header {
    current_lba: u64,
    backup_lba: u64,
    first_usable: u64,
    last_usable: u64,
    disk_guid: [u8; 16],
    entries_lba: u64,
    entry_count: u32,
    entry_size: u32,
    entries_crc: u32,
}

fn parse_header(bytes: &[u8], lba: u64, sectors: u64) -> Result<Header, TrustError> {
    let start = usize::try_from(lba.checked_mul(SECTOR_BYTES).ok_or(TrustError::Layout)?)
        .map_err(|_| TrustError::Layout)?;
    let header = bytes
        .get(start..start + SECTOR_BYTES as usize)
        .ok_or(TrustError::Layout)?;
    if &header[..8] != b"EFI PART"
        || u32_at(header, 8)? != 0x0001_0000
        || u32_at(header, 12)? != 92
        || u32_at(header, 20)? != 0
        || header[92..].iter().any(|byte| *byte != 0)
    {
        return Err(TrustError::Layout);
    }
    let stored_crc = u32_at(header, 16)?;
    let mut crc_bytes = header[..92].to_vec();
    crc_bytes[16..20].fill(0);
    if crc32(&crc_bytes) != stored_crc {
        return Err(TrustError::Layout);
    }
    let disk_guid = header[56..72].try_into().map_err(|_| TrustError::Layout)?;
    let result = Header {
        current_lba: u64_at(header, 24)?,
        backup_lba: u64_at(header, 32)?,
        first_usable: u64_at(header, 40)?,
        last_usable: u64_at(header, 48)?,
        disk_guid,
        entries_lba: u64_at(header, 72)?,
        entry_count: u32_at(header, 80)?,
        entry_size: u32_at(header, 84)?,
        entries_crc: u32_at(header, 88)?,
    };
    if result.current_lba >= sectors || result.backup_lba >= sectors {
        return Err(TrustError::Layout);
    }
    Ok(result)
}

fn parse_partition(
    entries: &[u8],
    index: usize,
    expected_name: &str,
) -> Result<Partition, TrustError> {
    let offset = index
        .checked_mul(GPT_ENTRY_BYTES)
        .ok_or(TrustError::Layout)?;
    let entry = entries
        .get(offset..offset + GPT_ENTRY_BYTES)
        .ok_or(TrustError::Layout)?;
    let type_guid: [u8; 16] = entry[..16].try_into().map_err(|_| TrustError::Layout)?;
    let unique_guid = &entry[16..32];
    if type_guid == [0; 16] || unique_guid == [0; 16] {
        return Err(TrustError::Layout);
    }
    let first_lba = u64_at(entry, 32)?;
    let last_lba = u64_at(entry, 40)?;
    let attributes = u64_at(entry, 48)?;
    let name = decode_name(&entry[56..128])?;
    if name != expected_name || first_lba > last_lba {
        return Err(TrustError::Layout);
    }
    Ok(Partition {
        number: (index + 1) as u8,
        first_lba,
        last_lba,
        type_guid,
        unique_guid: unique_guid.try_into().map_err(|_| TrustError::Layout)?,
        attributes,
    })
}

fn validate_partitions(parts: &[Partition; 4], sectors: u64) -> Result<(), TrustError> {
    let [bios, esp, base, exchange] = parts;
    let unique_guids: std::collections::BTreeSet<_> = parts
        .iter()
        .map(|partition| partition.unique_guid)
        .collect();
    if unique_guids.len() != parts.len() || unique_guids.iter().any(|guid| *guid == [0; 16]) {
        return Err(TrustError::Layout);
    }
    let end = |partition: &Partition| partition.last_lba.checked_add(1).ok_or(TrustError::Layout);
    for partition in parts {
        if partition.first_lba >= sectors || partition.last_lba >= sectors {
            return Err(TrustError::Layout);
        }
    }
    let esp_end = end(esp)?;
    let base_end = end(base)?;
    let exchange_end = end(exchange)?;
    if bios.type_guid != BIOS_BOOT
        || bios.first_lba != 2048
        || bios.last_lba != 4095
        || bios.attributes != 0
        || esp.type_guid != EFI_SYSTEM
        || esp.first_lba != 4096
        || esp.first_lba % 2048 != 0
        || esp_end % 2048 != 0
        || esp_end
            .checked_sub(esp.first_lba)
            .is_none_or(|size| size < 128 * 2048)
        || esp.attributes != LEGACY_BIOS_BOOTABLE
        || base.type_guid != LINUX_FILESYSTEM
        || base.first_lba != esp_end
        || base.first_lba % 2048 != 0
        || base_end % 2048 != 0
        || base_end
            .checked_sub(base.first_lba)
            .is_none_or(|size| size < MIN_BASE_PARTITION_MIB * 2048)
        || base.attributes != 0
        || exchange.type_guid != BASIC_DATA
        || exchange.first_lba != base_end
        || exchange.first_lba % 2048 != 0
        || exchange_end.checked_sub(exchange.first_lba) != Some(32 * 2048)
        || exchange.attributes != 0
        || exchange_end.checked_add(2048) != Some(sectors)
    {
        return Err(TrustError::Layout);
    }
    for pair in parts.windows(2) {
        if pair[0].last_lba >= pair[1].first_lba {
            return Err(TrustError::Layout);
        }
    }
    if parts[3].last_lba
        >= sectors
            .checked_sub(GPT_TRAILER_SECTORS)
            .ok_or(TrustError::Layout)?
    {
        return Err(TrustError::Layout);
    }
    Ok(())
}

fn validate_mbr(bytes: &[u8], sectors: u64) -> Result<(), TrustError> {
    let mbr = bytes.get(..512).ok_or(TrustError::Layout)?;
    if mbr[510..512] != [0x55, 0xaa] {
        return Err(TrustError::Layout);
    }
    let entry = &mbr[446..462];
    let expected_size = (sectors - 1).min(u32::MAX as u64) as u32;
    if entry[4] != 0xee
        || u32::from_le_bytes(entry[8..12].try_into().map_err(|_| TrustError::Layout)?) != 1
        || u32::from_le_bytes(entry[12..16].try_into().map_err(|_| TrustError::Layout)?)
            != expected_size
        || mbr[462..510].iter().any(|byte| *byte != 0)
    {
        return Err(TrustError::Layout);
    }
    Ok(())
}

fn decode_name(bytes: &[u8]) -> Result<String, TrustError> {
    if bytes.len() != 72 {
        return Err(TrustError::Layout);
    }
    let mut units = Vec::with_capacity(36);
    for pair in bytes.as_chunks::<2>().0 {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    String::from_utf16(&units).map_err(|_| TrustError::Layout)
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, TrustError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or(TrustError::Layout)?
            .try_into()
            .map_err(|_| TrustError::Layout)?,
    ))
}

fn u64_at(bytes: &[u8], at: usize) -> Result<u64, TrustError> {
    Ok(u64::from_le_bytes(
        bytes
            .get(at..at + 8)
            .ok_or(TrustError::Layout)?
            .try_into()
            .map_err(|_| TrustError::Layout)?,
    ))
}

pub(crate) fn put_u32(bytes: &mut [u8], at: usize, value: u32) -> Result<(), TrustError> {
    bytes
        .get_mut(at..at + 4)
        .ok_or(TrustError::Layout)?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}

pub(crate) fn put_u64(bytes: &mut [u8], at: usize, value: u64) -> Result<(), TrustError> {
    bytes
        .get_mut(at..at + 8)
        .ok_or(TrustError::Layout)?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}

pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(feature = "file-test")]
pub fn synthetic_sfdisk_contract_fixture() -> Vec<u8> {
    let esp_start = 4096_u64;
    let esp_end = esp_start + 128 * 2048;
    let base_end = esp_end + MIN_BASE_PARTITION_MIB * 2048;
    let exchange_end = base_end + 32 * 2048;
    let sectors = exchange_end + 2048;
    let mut image = vec![0; (sectors * 512) as usize];
    image[440..446].copy_from_slice(b"AISMBR");
    image[446 + 4] = 0xee;
    image[446 + 8..446 + 12].copy_from_slice(&1_u32.to_le_bytes());
    image[446 + 12..446 + 16].copy_from_slice(&((sectors - 1) as u32).to_le_bytes());
    image[510..512].copy_from_slice(&[0x55, 0xaa]);
    let mut entries = vec![0; GPT_ARRAY_BYTES];
    let partitions = [
        (BIOS_BOOT, 2048, 4095, 0, "BIOS"),
        (
            EFI_SYSTEM,
            esp_start,
            esp_end - 1,
            LEGACY_BIOS_BOOTABLE,
            "AISBOOT",
        ),
        (LINUX_FILESYSTEM, esp_end, base_end - 1, 0, "AISBASE"),
        (BASIC_DATA, base_end, exchange_end - 1, 0, "AISX"),
    ];
    for (index, (type_guid, first, last, attributes, name)) in partitions.into_iter().enumerate() {
        let entry = &mut entries[index * GPT_ENTRY_BYTES..(index + 1) * GPT_ENTRY_BYTES];
        entry[..16].copy_from_slice(&type_guid);
        entry[16..32].copy_from_slice(&[index as u8 + 1; 16]);
        entry[32..40].copy_from_slice(&first.to_le_bytes());
        entry[40..48].copy_from_slice(&last.to_le_bytes());
        entry[48..56].copy_from_slice(&attributes.to_le_bytes());
        for (unit_index, unit) in name.encode_utf16().enumerate() {
            let at = 56 + unit_index * 2;
            entry[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
    }
    let primary_entries = 2 * 512;
    image[primary_entries..primary_entries + GPT_ARRAY_BYTES].copy_from_slice(&entries);
    let backup_entries_lba = sectors - GPT_TRAILER_SECTORS;
    let backup_entries = (backup_entries_lba * 512) as usize;
    image[backup_entries..backup_entries + GPT_ARRAY_BYTES].copy_from_slice(&entries);
    let entries_crc = crc32(&entries);
    for (current, backup, entries_lba) in
        [(1, sectors - 1, 2), (sectors - 1, 1, backup_entries_lba)]
    {
        let start = (current * 512) as usize;
        let header = &mut image[start..start + 512];
        header[..8].copy_from_slice(b"EFI PART");
        header[8..12].copy_from_slice(&0x0001_0000_u32.to_le_bytes());
        header[12..16].copy_from_slice(&92_u32.to_le_bytes());
        header[24..32].copy_from_slice(&current.to_le_bytes());
        header[32..40].copy_from_slice(&backup.to_le_bytes());
        header[40..48].copy_from_slice(&2048_u64.to_le_bytes());
        header[48..56].copy_from_slice(&(sectors - 34).to_le_bytes());
        header[56..72].copy_from_slice(&[0x53; 16]);
        header[72..80].copy_from_slice(&entries_lba.to_le_bytes());
        header[80..84].copy_from_slice(&(GPT_ENTRY_COUNT as u32).to_le_bytes());
        header[84..88].copy_from_slice(&(GPT_ENTRY_BYTES as u32).to_le_bytes());
        header[88..92].copy_from_slice(&entries_crc.to_le_bytes());
        let crc = crc32(&header[..92]);
        header[16..20].copy_from_slice(&crc.to_le_bytes());
    }
    crate::drive_identity::fixture_esp(
        &mut image[(esp_start * 512) as usize..(esp_end * 512) as usize],
    );
    image
}

#[cfg(test)]
mod tests {
    use super::*;

    // Geometry follows B's sfdisk input: a 128 MiB ESP, 65 MiB minimum base,
    // 32 MiB exchange, 1 MiB-aligned starts and 1 MiB tail.
    // The independent sfdisk contract fixes first_usable at LBA 2048.
    fn sfdisk_contract_fixture() -> Vec<u8> {
        sfdisk_contract_fixture_with_base_mib(MIN_BASE_PARTITION_MIB)
    }

    fn sfdisk_contract_fixture_with_base_mib(base_mib: u64) -> Vec<u8> {
        let esp_start = 4096_u64;
        let esp_end = esp_start + 128 * 2048;
        let base_end = esp_end + base_mib * 2048;
        let exchange_end = base_end + 32 * 2048;
        let sectors = exchange_end + 2048;
        let mut image = vec![0; (sectors * 512) as usize];
        image[440..446].copy_from_slice(b"AISMBR");
        image[446 + 4] = 0xee;
        image[446 + 8..446 + 12].copy_from_slice(&1_u32.to_le_bytes());
        image[446 + 12..446 + 16].copy_from_slice(&((sectors - 1) as u32).to_le_bytes());
        image[510..512].copy_from_slice(&[0x55, 0xaa]);

        let mut entries = vec![0; GPT_ARRAY_BYTES];
        let partitions = [
            (BIOS_BOOT, 2048, 4095, 0, "BIOS"),
            (
                EFI_SYSTEM,
                esp_start,
                esp_end - 1,
                LEGACY_BIOS_BOOTABLE,
                "AISBOOT",
            ),
            (LINUX_FILESYSTEM, esp_end, base_end - 1, 0, "AISBASE"),
            (BASIC_DATA, base_end, exchange_end - 1, 0, "AISX"),
        ];
        for (index, (type_guid, first, last, attributes, name)) in
            partitions.into_iter().enumerate()
        {
            let entry = &mut entries[index * GPT_ENTRY_BYTES..(index + 1) * GPT_ENTRY_BYTES];
            entry[..16].copy_from_slice(&type_guid);
            entry[16..32].copy_from_slice(&[index as u8 + 1; 16]);
            entry[32..40].copy_from_slice(&first.to_le_bytes());
            entry[40..48].copy_from_slice(&last.to_le_bytes());
            entry[48..56].copy_from_slice(&attributes.to_le_bytes());
            for (unit_index, unit) in name.encode_utf16().enumerate() {
                let at = 56 + unit_index * 2;
                entry[at..at + 2].copy_from_slice(&unit.to_le_bytes());
            }
        }
        let primary_entries = 2 * 512;
        image[primary_entries..primary_entries + GPT_ARRAY_BYTES].copy_from_slice(&entries);
        let backup_entries_lba = sectors - GPT_TRAILER_SECTORS;
        let backup_entries = (backup_entries_lba * 512) as usize;
        image[backup_entries..backup_entries + GPT_ARRAY_BYTES].copy_from_slice(&entries);
        let entries_crc = test_crc32(&entries);
        write_header(&mut image, 1, sectors - 1, 2, sectors, entries_crc);
        write_header(
            &mut image,
            sectors - 1,
            1,
            backup_entries_lba,
            sectors,
            entries_crc,
        );
        image
    }

    fn write_header(
        image: &mut [u8],
        current: u64,
        backup: u64,
        entries: u64,
        sectors: u64,
        entries_crc: u32,
    ) {
        let start = (current * 512) as usize;
        let header = &mut image[start..start + 512];
        header[..8].copy_from_slice(b"EFI PART");
        header[8..12].copy_from_slice(&0x0001_0000_u32.to_le_bytes());
        header[12..16].copy_from_slice(&92_u32.to_le_bytes());
        header[24..32].copy_from_slice(&current.to_le_bytes());
        header[32..40].copy_from_slice(&backup.to_le_bytes());
        header[40..48].copy_from_slice(&2048_u64.to_le_bytes());
        header[48..56].copy_from_slice(&(sectors - 34).to_le_bytes());
        header[56..72].copy_from_slice(&[0x53; 16]);
        header[72..80].copy_from_slice(&entries.to_le_bytes());
        header[80..84].copy_from_slice(&(GPT_ENTRY_COUNT as u32).to_le_bytes());
        header[84..88].copy_from_slice(&(GPT_ENTRY_BYTES as u32).to_le_bytes());
        header[88..92].copy_from_slice(&entries_crc.to_le_bytes());
        header[16..20].fill(0);
        let crc = test_crc32(&header[..92]);
        header[16..20].copy_from_slice(&crc.to_le_bytes());
    }

    fn refresh_array_and_header_crcs(image: &mut [u8]) {
        let sectors = image.len() as u64 / 512;
        let array_start = 2 * 512;
        let array = image[array_start..array_start + GPT_ARRAY_BYTES].to_vec();
        let backup_lba = sectors - GPT_TRAILER_SECTORS;
        let backup_start = (backup_lba * 512) as usize;
        image[backup_start..backup_start + GPT_ARRAY_BYTES].copy_from_slice(&array);
        let entries_crc = test_crc32(&array);
        for lba in [1, sectors - 1] {
            let start = (lba * 512) as usize;
            let header = &mut image[start..start + 512];
            header[88..92].copy_from_slice(&entries_crc.to_le_bytes());
            header[16..20].fill(0);
            let crc = test_crc32(&header[..92]);
            header[16..20].copy_from_slice(&crc.to_le_bytes());
        }
    }

    fn test_crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn accepts_b_sfdisk_geometry_with_first_usable_lba_2048() {
        let image = sfdisk_contract_fixture();
        let layout = LiveImageLayout::parse(&image).expect("valid B geometry");
        assert_eq!(layout.partitions[0].first_lba, 2048);
        assert_eq!(
            layout.partitions[2].last_lba + 1 - layout.partitions[2].first_lba,
            MIN_BASE_PARTITION_MIB * 2048
        );
        assert_eq!(layout.partitions[1].attributes, LEGACY_BIOS_BOOTABLE);
        assert_eq!(layout.p4_end_lba(), layout.partitions[3].last_lba + 1);
    }

    #[test]
    fn rejects_base_partition_below_builder_minimum() {
        let image = sfdisk_contract_fixture_with_base_mib(MIN_BASE_PARTITION_MIB - 1);
        assert!(matches!(
            LiveImageLayout::parse(&image),
            Err(TrustError::Layout)
        ));
    }

    #[test]
    fn rejects_overflow_and_duplicate_guids_even_with_valid_crcs() {
        let mut image = sfdisk_contract_fixture();
        let first = 2 * 512;
        image[first + 2 * GPT_ENTRY_BYTES + 32..first + 2 * GPT_ENTRY_BYTES + 40]
            .copy_from_slice(&u64::MAX.to_le_bytes());
        refresh_array_and_header_crcs(&mut image);
        assert!(LiveImageLayout::parse(&image).is_err());

        let mut image = sfdisk_contract_fixture();
        let first = 2 * 512;
        let guid = image[first + 16..first + 32].to_vec();
        image[first + GPT_ENTRY_BYTES + 16..first + GPT_ENTRY_BYTES + 32].copy_from_slice(&guid);
        refresh_array_and_header_crcs(&mut image);
        assert!(LiveImageLayout::parse(&image).is_err());
    }
}
