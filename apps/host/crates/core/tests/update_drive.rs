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
    update_journal::{JOURNAL_NAME, SealedJournal, UpdateJournal},
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
fn update_resumes_each_partition_without_changing_exchange_persist_or_identity() {
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
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).unwrap();
    let exchange_path = directory.join(format!(
        "exchange-SYNTHETIC-FIXTURE-{}",
        ais_host_core::release::hex(&nonce)
    ));
    std::fs::create_dir(&exchange_path).unwrap();
    std::fs::write(exchange_path.join("model.bin"), b"SYNTHETIC_FIXTURE_MODEL").unwrap();
    std::fs::write(exchange_path.join("inbox.age"), b"SYNTHETIC_FIXTURE_INBOX").unwrap();
    let exchange =
        ais_host_core::exchange_root::ExchangeRoot::test_directory(&exchange_path).unwrap();
    let journal = UpdateJournal::new(&image, installed.clone()).unwrap();
    journal
        .check_drive(&snapshot, &installed, "updating")
        .unwrap();
    assert!(
        journal
            .check_drive(&snapshot, &unknown, "updating")
            .unwrap_err()
            .contains("identities")
    );
    assert!(journal.check_image(&old).unwrap_err().contains("SHA-256"));
    // An intact, authenticated journal copied from a different drive is refused.
    let other_journal = UpdateJournal::new(&image, unknown.clone()).unwrap();
    let other_sealed =
        SealedJournal::publish(&exchange, &other_journal, "SYNTHETIC_FIXTURE_12").unwrap();
    let copied = other_sealed.authenticate("SYNTHETIC_FIXTURE_12").unwrap();
    assert!(
        copied
            .check_drive(&snapshot, &installed, "updating")
            .unwrap_err()
            .contains("identities")
    );
    assert_eq!(
        before,
        [
            digest(&mut target, partition_range(&parts[3])),
            digest(&mut target, partition_range(&parts[4])),
        ]
    );
    assert!(SealedJournal::load(&exchange).unwrap().is_some());
    // Test-only removal of the deliberately foreign fixture.
    std::fs::remove_file(exchange_path.join(JOURNAL_NAME)).unwrap();
    // Power loss after the registry advance must still permit the same recovery.
    let completed = InstalledImage::new(&image, identity.clone(), &snapshot.observation);
    journal
        .check_drive(&snapshot, &completed, "writtenAwaitingBoot")
        .unwrap();
    // A journal replayed while a later update is in progress is refused.
    assert!(
        journal
            .check_drive(&snapshot, &completed, "updating")
            .unwrap_err()
            .contains("identities")
    );

    // Disconnect immediately after each complete partition write, including the
    // final ESP before its readback, and also exercise partially written data.
    let base_bytes = partition_range(&source.partitions[2]).length as usize;
    let bios_bytes = partition_range(&source.partitions[0]).length as usize;
    let esp_bytes = partition_range(&source.partitions[1]).length as usize;
    for limit in [
        64 * 1024,
        base_bytes,
        base_bytes + bios_bytes,
        base_bytes + bios_bytes + 64 * 1024,
        base_bytes + bios_bytes + esp_bytes,
    ] {
        let sealed = SealedJournal::publish(&exchange, &journal, "SYNTHETIC_FIXTURE_12").unwrap();
        let mut fault = FaultTarget::new(target);
        fault.disconnect_after = Some(limit);
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
        assert!(SealedJournal::load(&exchange).unwrap().is_some());
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
        // Reconnect and re-verify the original signed image, not a newer release.
        let sealed_after_reconnect = SealedJournal::load(&exchange).unwrap().unwrap();
        let recovered = sealed_after_reconnect
            .authenticate("SYNTHETIC_FIXTURE_12")
            .unwrap();
        recovered
            .check_drive(&interrupted, &installed, "updating")
            .unwrap();
        let (_, mut resumed_image) = newer.verify_live_layout(&directory).unwrap();
        recovered.check_image(&resumed_image).unwrap();
        let resume =
            WritePlan::update_drive(&resumed_image, &interrupted, recovered.previous()).unwrap();
        let ticket = approvals
            .issue(
                &resume,
                &resume.device().display_identifier,
                Instant::now(),
                Duration::from_secs(120),
            )
            .unwrap();
        write_image(
            &mut target,
            &mut resumed_image,
            &resume,
            &mut approvals,
            &ticket,
            || false,
        )
        .unwrap();
        sealed.finish(&exchange).unwrap();
        assert!(SealedJournal::load(&exchange).unwrap().is_none());
        assert_eq!(
            before,
            [
                digest(&mut target, partition_range(&parts[3])),
                digest(&mut target, partition_range(&parts[4])),
            ]
        );
        assert_eq!(
            std::fs::read(exchange_path.join("model.bin")).unwrap(),
            b"SYNTHETIC_FIXTURE_MODEL"
        );
        assert_eq!(
            std::fs::read(exchange_path.join("inbox.age")).unwrap(),
            b"SYNTHETIC_FIXTURE_INBOX"
        );
        assert_eq!(std::fs::read_dir(&exchange_path).unwrap().count(), 2);
        target = target.reopen().unwrap();
    }
    // Authenticated intent refuses a changed drive and any ciphertext edits.
    // Replacing the mount path must never redirect journal I/O from its handle.
    let retained_path = exchange_path.with_extension("retained");
    std::fs::rename(&exchange_path, &retained_path).unwrap();
    std::fs::create_dir(&exchange_path).unwrap();
    let sealed = SealedJournal::publish(&exchange, &journal, "SYNTHETIC_FIXTURE_12").unwrap();
    assert!(!exchange_path.join(JOURNAL_NAME).exists());
    assert!(sealed.authenticate("SYNTHETIC_FIXTURE_WRONG").is_err());
    assert!(SealedJournal::publish(&exchange, &journal, "SYNTHETIC_FIXTURE_12").is_err());
    let original = std::fs::read(retained_path.join(JOURNAL_NAME)).unwrap();
    let mut altered = original.clone();
    *altered.last_mut().unwrap() ^= 1;
    std::fs::write(retained_path.join(JOURNAL_NAME), &altered).unwrap();
    assert!(
        SealedJournal::load(&exchange)
            .unwrap()
            .unwrap()
            .authenticate("SYNTHETIC_FIXTURE_12")
            .is_err()
    );
    assert!(
        sealed.finish(&exchange).is_err(),
        "a changed journal is retained"
    );
    assert_eq!(
        std::fs::read(retained_path.join(JOURNAL_NAME)).unwrap(),
        altered
    );
    std::fs::write(retained_path.join(JOURNAL_NAME), &original).unwrap();
    sealed.finish(&exchange).unwrap();
    // Refuse a structurally changed intent even if it could be authenticated.
    let mut changed = serde_json::to_value(&journal).unwrap();
    changed["partitions"] = serde_json::json!([3, 4, 5]);
    let changed: UpdateJournal = serde_json::from_value(changed).unwrap();
    assert!(SealedJournal::publish(&exchange, &changed, "SYNTHETIC_FIXTURE_12").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("model.bin", retained_path.join(JOURNAL_NAME)).unwrap();
        assert!(SealedJournal::load(&exchange).is_err());
        std::fs::remove_file(retained_path.join(JOURNAL_NAME)).unwrap();
        std::fs::hard_link(
            retained_path.join("model.bin"),
            retained_path.join(JOURNAL_NAME),
        )
        .unwrap();
        assert!(SealedJournal::load(&exchange).is_err());
        std::fs::remove_file(retained_path.join(JOURNAL_NAME)).unwrap();
    }
    assert_eq!(
        std::fs::read(retained_path.join("model.bin")).unwrap(),
        b"SYNTHETIC_FIXTURE_MODEL"
    );
    assert_eq!(std::fs::read_dir(&retained_path).unwrap().count(), 2);
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
    drop(exchange);
    std::fs::remove_dir_all(exchange_path).unwrap();
    std::fs::remove_dir_all(retained_path).unwrap();
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
