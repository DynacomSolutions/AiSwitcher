#![cfg(feature = "file-test")]
use ais_host_core::{
    device::{ByteRange, ConfirmationBook, DeviceError, WritePlan, WriteTarget},
    file_test::{FileTarget, SyntheticRelease},
};
use std::time::{Duration, Instant};

#[test]
fn exact_identifier_expiry_invalidation_and_replay() {
    let fixture = SyntheticRelease::new(vec![0x43; 512]);
    let (_, image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let device = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, device.clone()).unwrap();
    let mut book = ConfirmationBook::default();
    let now = Instant::now();
    for typed in [
        "",
        "SYNTHETIC_FIXTURE_OTHER",
        " SYNTHETIC_FIXTURE_DISK",
        "SYNTHETIC_FIXTURE_DISK ",
    ] {
        assert!(matches!(
            book.issue(&plan, typed, now, Duration::from_secs(10)),
            Err(DeviceError::Confirmation)
        ));
    }
    let issue = |book: &mut ConfirmationBook| {
        book.issue(
            &plan,
            &device.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap()
    };
    let ticket = issue(&mut book);
    assert_eq!(
        book.consume(
            &ticket,
            &plan,
            &device,
            &image,
            now + Duration::from_secs(10)
        ),
        Err(DeviceError::Stale)
    );
    let ticket = issue(&mut book);
    book.invalidate();
    assert_eq!(
        book.consume(&ticket, &plan, &device, &image, now),
        Err(DeviceError::Stale)
    );
    let ticket = issue(&mut book);
    book.consume(&ticket, &plan, &device, &image, now).unwrap();
    assert_eq!(
        book.consume(&ticket, &plan, &device, &image, now),
        Err(DeviceError::Stale)
    );
    assert!(
        book.issue(
            &plan,
            &device.display_identifier,
            now,
            Duration::from_secs(121)
        )
        .is_err()
    );
}

#[test]
fn every_identity_or_eligibility_change_invalidates_plan() {
    let fixture = SyntheticRelease::new(vec![0x43; 512]);
    let (_, image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let device = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, device.clone()).unwrap();
    assert!(device.serial.is_none());
    for mutation in 0..15 {
        let mut changed = device.clone();
        match mutation {
            0 => changed.capacity_bytes += 512,
            1 => changed.os_identity.push('x'),
            2 => changed.connection_identity.push('x'),
            3 => changed.serial = Some("SYNTHETIC_FIXTURE_SERIAL".into()),
            4 => changed.table_fingerprint[0] ^= 1,
            5 => changed.ancestry_fingerprint[0] ^= 1,
            6 => changed.mount_fingerprint[0] ^= 1,
            7 => changed.internal = true,
            8 => changed.system_backing = true,
            9 => changed.ancestry_complete = false,
            10 => changed.external_usb = false,
            11 => changed.writable = false,
            12 => changed.sector_bytes = 0,
            13 => changed.connection_identity.clear(),
            _ => changed.display_identifier.push('x'),
        }
        assert!(
            plan.revalidate(&changed, &image).is_err(),
            "mutation {mutation}"
        );
    }
    assert_eq!(
        WritePlan::create_layout(&image, device).unwrap_err(),
        DeviceError::LayoutUnavailable
    );
}

#[test]
fn rejects_overflow_unaligned_empty_and_out_of_bounds_ranges() {
    let target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let device = target.observe().unwrap();
    for range in [
        ByteRange {
            start: 1,
            length: 512,
        },
        ByteRange {
            start: 0,
            length: 1,
        },
        ByteRange {
            start: 0,
            length: 0,
        },
        ByteRange {
            start: 4096,
            length: 512,
        },
        ByteRange {
            start: u64::MAX - 511,
            length: 512,
        },
    ] {
        assert_eq!(range.validate(&device), Err(DeviceError::Bounds));
    }
}
