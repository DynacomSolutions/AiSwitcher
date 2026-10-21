#![cfg(feature = "file-test")]
use ais_host_core::{
    device::{ByteRange, ConfirmationBook, LUKS_HEADER_BYTES, WritePlan, WriteTarget, write_image},
    file_test::{FileTarget, SyntheticRelease},
    layout::synthetic_sfdisk_contract_fixture,
    release::sha256_reader,
    update::{DriveSnapshot, InstalledImage, partition_range},
};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    time::{Duration, Instant},
};

fn digest(target: &mut FileTarget, start: u64, length: u64) -> [u8; 32] {
    target.seek(SeekFrom::Start(start)).unwrap();
    sha256_reader(&mut target.take(length)).unwrap()
}

fn snapshot(target: &mut FileTarget) -> DriveSnapshot {
    DriveSnapshot::read(target.observe().unwrap(), |offset, bytes| {
        target.read_at(offset, bytes)
    })
    .unwrap()
}

#[test]
fn reset_zeroes_only_the_luks_header_area_of_partition_five() {
    let directory = std::env::temp_dir();
    let fixture = SyntheticRelease::new(synthetic_sfdisk_contract_fixture());
    let (_, mut image) = fixture.verify_live_layout(&directory).unwrap();
    let mut target = FileTarget::create_sparse(&directory, 3 * 1024 * 1024 * 1024).unwrap();
    let create = WritePlan::create_drive(&image, target.observe().unwrap()).unwrap();
    let identity = create.identity().unwrap().clone();
    let installed = InstalledImage::new(&image, identity.clone(), create.device());
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
        &mut image,
        &create,
        &mut approvals,
        &ticket,
        || false,
    )
    .unwrap();
    let mut target = target.reopen().unwrap();
    let parts = snapshot(&mut target).partitions(&identity).unwrap();
    let ranges: Vec<_> = parts.iter().map(partition_range).collect();
    let persist = ranges[4];

    // LUKS2 magic at both header offsets, key material at the end of the header
    // area, and sentinels just before and after it and in every other partition.
    let marks = [
        persist.start,
        persist.start + 16 * 1024,
        persist.start + LUKS_HEADER_BYTES - 512,
        persist.start + LUKS_HEADER_BYTES,
        persist.start + persist.length - 512,
        ranges[3].start,
        ranges[3].start + ranges[3].length - 512,
    ];
    for at in marks {
        target.seek(SeekFrom::Start(at)).unwrap();
        target.write_all(&[0xa7; 512]).unwrap();
    }
    target.seek(SeekFrom::Start(persist.start)).unwrap();
    target.write_all(b"LUKS\xba\xbe").unwrap();
    target
        .seek(SeekFrom::Start(persist.start + 16 * 1024))
        .unwrap();
    target.write_all(b"SKUL\xba\xbe").unwrap();

    let snapshot = snapshot(&mut target);
    let capacity = target.observe().unwrap().capacity_bytes;
    let outside = |target: &mut FileTarget| {
        // Everything except [persist.start, persist.start + 16 MiB).
        let header_end = persist.start + LUKS_HEADER_BYTES;
        (
            digest(target, 0, persist.start),
            digest(target, header_end, capacity - header_end),
        )
    };
    let before = outside(&mut target);

    let plan = WritePlan::reset_persist(&image, &snapshot, &installed).unwrap();
    assert_eq!(
        plan.ranges(),
        [ByteRange {
            start: persist.start,
            length: LUKS_HEADER_BYTES
        }]
    );
    let range = plan.ranges()[0];
    assert!(range.start >= persist.start);
    assert!(range.start + range.length <= persist.start + persist.length);
    for other in &ranges[..4] {
        assert!(
            range.start >= other.start + other.length,
            "overlaps a base partition"
        );
    }
    assert!(
        range.start + range.length <= capacity - 33 * 512,
        "overlaps the backup GPT"
    );
    assert_eq!(
        plan.digest(),
        WritePlan::reset_persist(&image, &snapshot, &installed)
            .unwrap()
            .digest()
    );

    // Wrong or unknown identities cannot produce a plan.
    let mut unknown = installed.clone();
    unknown.identity = ais_host_core::drive_identity::DriveIdentity::fresh().unwrap();
    assert!(WritePlan::reset_persist(&image, &snapshot, &unknown).is_err());
    let mut wrong_sector = snapshot.clone();
    wrong_sector.observation.sector_bytes = 4096;
    assert!(WritePlan::reset_persist(&image, &wrong_sector, &installed).is_err());

    let ticket = approvals
        .issue(
            &plan,
            &plan.device().display_identifier,
            Instant::now(),
            Duration::from_secs(120),
        )
        .unwrap();
    let written = write_image(
        &mut target,
        &mut image,
        &plan,
        &mut approvals,
        &ticket,
        || false,
    )
    .unwrap();
    assert_eq!(written, LUKS_HEADER_BYTES);

    let mut header = vec![0; LUKS_HEADER_BYTES as usize];
    target.read_at(persist.start, &mut header).unwrap();
    assert!(
        header.iter().all(|byte| *byte == 0),
        "the first 16 MiB must be blank"
    );
    let mut magic = [0; 6];
    for at in [persist.start, persist.start + 16 * 1024] {
        target.read_at(at, &mut magic).unwrap();
        assert_eq!(magic, [0; 6]);
    }
    assert_eq!(
        outside(&mut target),
        before,
        "no byte outside the header area changed"
    );
    let after = self::snapshot(&mut target);
    assert_eq!(after.head, snapshot.head);
    assert_eq!(after.tail, snapshot.tail);
    // A second approval cannot be replayed.
    assert!(
        write_image(
            &mut target,
            &mut image,
            &plan,
            &mut approvals,
            &ticket,
            || false
        )
        .is_err()
    );
}
