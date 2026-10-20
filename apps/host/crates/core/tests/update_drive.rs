#![cfg(feature = "file-test")]
use ais_host_core::{
    device::{ByteRange, ConfirmationBook, WriteFailure, WritePlan, WriteTarget, write_image},
    drive_identity::verify_esp,
    file_test::{FaultTarget, FileTarget, SyntheticRelease},
    layout::{
        LiveImageLayout, synthetic_sfdisk_contract_fixture, synthetic_sfdisk_contract_with_base,
    },
    release::sha256_reader,
    update::{DriveSnapshot, InstalledImage, partition_range},
};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    time::{Duration, Instant},
};

fn digest(target: &mut FileTarget, range: ByteRange) -> [u8; 32] {
    target.seek(SeekFrom::Start(range.start)).unwrap();
    sha256_reader(&mut target.take(range.length)).unwrap()
}

#[test]
fn update_preserves_data_and_all_identities_and_refuses_unsafe_plans() {
    let directory = std::env::temp_dir();
    let fixture = SyntheticRelease::new(synthetic_sfdisk_contract_fixture());
    let (_, mut old) = fixture.verify_live_layout(&directory).unwrap();
    let mut target = FileTarget::create_sparse(&directory, 3 * 1024 * 1024 * 1024).unwrap();
    let create = WritePlan::create_drive(&old, target.observe().unwrap()).unwrap();
    let identity = create.identity().unwrap().clone();
    let installed = InstalledImage::new(&old, identity.clone(), create.device());
    let mut approvals = ConfirmationBook::default();
    let ticket = approvals
        .issue(
            &create,
            &create.device().display_identifier,
            Instant::now(),
            Duration::from_secs(120),
        )
        .unwrap();
    write_image(
        &mut target,
        &mut old,
        &create,
        &mut approvals,
        &ticket,
        || false,
    )
    .unwrap();
    let mut target = target.reopen().unwrap();
    let snapshot = DriveSnapshot::read(target.observe().unwrap(), |offset, bytes| {
        target.read_at(offset, bytes)
    })
    .unwrap();
    let parts = snapshot.partitions(&identity).unwrap();
    // Include an existing LUKS-shaped header and package/data sentinels at both ends.
    for index in [3, 4] {
        let range = partition_range(&parts[index]);
        for offset in [0, 16 * 1024 * 1024, range.length / 2, range.length - 512] {
            target.seek(SeekFrom::Start(range.start + offset)).unwrap();
            target.write_all(&[0xa7; 512]).unwrap();
        }
    }
    target
        .seek(SeekFrom::Start(partition_range(&parts[4]).start))
        .unwrap();
    target.write_all(b"LUKS\xba\xbeSYNTHETIC_FIXTURE").unwrap();
    let snapshot = DriveSnapshot::read(target.observe().unwrap(), |offset, bytes| {
        target.read_at(offset, bytes)
    })
    .unwrap();
    let before = [
        digest(&mut target, partition_range(&parts[3])),
        digest(&mut target, partition_range(&parts[4])),
    ];
    assert!(
        WritePlan::update_drive(&old, &snapshot, &installed).is_err(),
        "same release"
    );

    let mut raw = synthetic_sfdisk_contract_fixture();
    let source = LiveImageLayout::parse(&raw).unwrap();
    for index in [0, 2] {
        raw[(source.partitions[index].first_lba * 512) as usize] = 0x72;
    }
    let newer = SyntheticRelease::new_version(raw, 2);
    let (_, mut image) = newer.verify_live_layout(&directory).unwrap();
    let plan = WritePlan::update_drive(&image, &snapshot, &installed).unwrap();
    assert!(
        serde_json::to_vec(&plan).unwrap().len() < 16_384,
        "confirmation binds ESP content by digest, without expanding the partition into JSON"
    );
    assert_eq!(plan.identity(), Some(&identity));
    assert_eq!(plan.exchange_range(), create.exchange_range());
    for range in plan.ranges() {
        assert!(range.start >= parts[0].first_lba * 512);
        assert!(range.start + range.length <= (parts[2].last_lba + 1) * 512);
    }
    let mut unknown = installed.clone();
    unknown.identity = ais_host_core::drive_identity::DriveIdentity::fresh().unwrap();
    assert!(
        WritePlan::update_drive(&image, &snapshot, &unknown).is_err(),
        "unknown GUIDs"
    );
    let mut old_version = installed.clone();
    old_version.release_order = (3, 3);
    assert!(
        WritePlan::update_drive(&image, &snapshot, &old_version).is_err(),
        "downgrade"
    );
    let larger = SyntheticRelease::new_version(synthetic_sfdisk_contract_with_base(66), 3);
    let (_, too_large) = larger.verify_live_layout(&directory).unwrap();
    assert!(
        WritePlan::update_drive(&too_large, &snapshot, &installed).is_err(),
        "oversized base"
    );

    // A valid mirrored GPT with a different ESP/base boundary is incompatible.
    let mut incompatible = snapshot.clone();
    for (entry, field) in [(1, 40), (2, 32)] {
        let at = 1024 + entry * 128 + field;
        let old = u64::from_le_bytes(incompatible.head[at..at + 8].try_into().unwrap());
        incompatible.head[at..at + 8].copy_from_slice(&(old + 2048).to_le_bytes());
    }
    fix_crcs(&mut incompatible);
    assert!(incompatible.partitions(&identity).is_ok());
    assert!(WritePlan::update_drive(&image, &incompatible, &installed).is_err());
    let mut wrong_sector = snapshot.clone();
    wrong_sector.observation.sector_bytes = 4096;
    assert!(WritePlan::update_drive(&image, &wrong_sector, &installed).is_err());
    let mut incompatible_mbr = snapshot.clone();
    incompatible_mbr.head[0] ^= 1;
    fix_crcs(&mut incompatible_mbr);
    assert!(WritePlan::update_drive(&image, &incompatible_mbr, &installed).is_err());

    let mut fault = FaultTarget::new(target);
    let mut changed = fault.observe().unwrap();
    changed.mount_fingerprint[0] ^= 1;
    fault.observed = Some(changed);
    assert!(
        approvals
            .issue(
                &plan,
                "SYNTHETIC_FIXTURE_wrong",
                Instant::now(),
                Duration::from_secs(120)
            )
            .is_err()
    );
    let ticket = approvals
        .issue(
            &plan,
            &plan.device().display_identifier,
            Instant::now(),
            Duration::from_secs(120),
        )
        .unwrap();
    assert!(matches!(
        write_image(
            &mut fault,
            &mut image,
            &plan,
            &mut approvals,
            &ticket,
            || false
        ),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(fault.written, 0, "re-observe refuses before any write");
    let mut target = fault.inner.reopen().unwrap();
    // Interrupt within base, between base and boot, and within the ESP, then retry.
    let base_bytes = partition_range(&source.partitions[2]).length as usize;
    let bios_bytes = partition_range(&source.partitions[0]).length as usize;
    for limit in [64 * 1024, base_bytes, base_bytes + bios_bytes + 64 * 1024] {
        let mut fault = FaultTarget::new(target);
        fault.fail_after = Some(limit);
        let ticket = approvals
            .issue(
                &plan,
                &plan.device().display_identifier,
                Instant::now(),
                Duration::from_secs(120),
            )
            .unwrap();
        assert!(matches!(
            write_image(
                &mut fault,
                &mut image,
                &plan,
                &mut approvals,
                &ticket,
                || false
            ),
            Err(WriteFailure::Incomplete { .. })
        ));
        assert_eq!(fault.written, limit);
        target = fault.inner.reopen().unwrap();
        assert_eq!(
            before,
            [
                digest(&mut target, partition_range(&parts[3])),
                digest(&mut target, partition_range(&parts[4]))
            ]
        );
        let interrupted = DriveSnapshot::read(target.observe().unwrap(), |offset, bytes| {
            target.read_at(offset, bytes)
        })
        .unwrap();
        assert_eq!(interrupted.head, snapshot.head);
        assert_eq!(interrupted.tail, snapshot.tail);
        assert!(WritePlan::update_drive(&image, &interrupted, &installed).is_ok());
        assert!(
            matches!(
                write_image(
                    &mut target,
                    &mut image,
                    &plan,
                    &mut approvals,
                    &ticket,
                    || false
                ),
                Err(WriteFailure::Refused(_))
            ),
            "interruption consumes the old confirmation"
        );
    }
    let ticket = approvals
        .issue(
            &plan,
            &plan.device().display_identifier,
            Instant::now(),
            Duration::from_secs(120),
        )
        .unwrap();
    write_image(
        &mut target,
        &mut image,
        &plan,
        &mut approvals,
        &ticket,
        || false,
    )
    .unwrap();
    assert_eq!(
        before,
        [
            digest(&mut target, partition_range(&parts[3])),
            digest(&mut target, partition_range(&parts[4]))
        ]
    );
    let after = DriveSnapshot::read(target.observe().unwrap(), |offset, bytes| {
        target.read_at(offset, bytes)
    })
    .unwrap();
    assert_eq!(
        after.head, snapshot.head,
        "primary GPT and disk GUID unchanged"
    );
    assert_eq!(
        after.tail, snapshot.tail,
        "backup GPT and all PARTUUIDs unchanged"
    );
    after.partitions(&identity).unwrap();
    for index in [0, 2] {
        let range = partition_range(&source.partitions[index]);
        let mut bytes = vec![0; range.length as usize];
        target.read_at(range.start, &mut bytes).unwrap();
        assert_eq!(
            bytes,
            newer.raw[range.start as usize..(range.start + range.length) as usize]
        );
    }
    let esp = partition_range(&parts[1]);
    let mut bytes = vec![0; esp.length as usize];
    target.read_at(esp.start, &mut bytes).unwrap();
    verify_esp(&bytes, &identity).unwrap();
    std::fs::remove_file(target.path()).unwrap();
}

fn fix_crcs(snapshot: &mut DriveSnapshot) {
    fn crc(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & (crc & 1).wrapping_neg());
            }
        }
        !crc
    }
    let entries = &snapshot.head[1024..1024 + 16384];
    let checksum = crc(entries);
    snapshot.tail[512..512 + 16384].copy_from_slice(entries);
    let tail_start = snapshot.tail.len() - 512;
    for header in [
        &mut snapshot.head[512..1024],
        &mut snapshot.tail[tail_start..],
    ] {
        header[88..92].copy_from_slice(&checksum.to_le_bytes());
        header[16..20].fill(0);
        let checksum = crc(&header[..92]);
        header[16..20].copy_from_slice(&checksum.to_le_bytes());
    }
    snapshot.observation.table_fingerprint =
        ais_host_core::device::table_fingerprint(&snapshot.head, &snapshot.tail).unwrap();
}
