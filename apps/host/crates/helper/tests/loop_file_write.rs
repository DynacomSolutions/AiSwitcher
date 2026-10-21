//! The Linux write stage against a regular "loop" file, never a block device.
#![cfg(all(target_os = "linux", feature = "file-test"))]
use ais_host_core::{
    device::{WritePlan, WriteTarget},
    file_test::{FileTarget, SENTINEL, SyntheticRelease},
};
use ais_host_helper::{protocol::linux_transport::boottime_ns, service::write_confirmed};

fn fixture(raw: &[u8]) -> (FileTarget, ais_host_core::release::VerifiedImage, WritePlan) {
    let dir = std::env::temp_dir();
    let (_, image) = SyntheticRelease::new(raw.to_vec()).verify(&dir).unwrap();
    let target = FileTarget::create(&dir, 4096).unwrap();
    let plan = WritePlan::synthetic_image(&image, target.observe().unwrap()).unwrap();
    (target, image, plan)
}

#[test]
fn confirmed_plan_writes_only_the_image_and_flushes() {
    let raw = vec![0x53; 512];
    let (mut target, mut image, plan) = fixture(&raw);
    let name = plan.device().display_identifier.clone();
    let deadline = boottime_ns().unwrap() + 60_000_000_000;
    let written = write_confirmed(&mut target, deadline, &mut image, &plan, &name);
    assert!(written.is_ok(), "{written:?}");
    let bytes = target.read_all().unwrap();
    assert_eq!(&bytes[..512], raw.as_slice());
    assert!(bytes[512..].iter().all(|byte| *byte == SENTINEL));
}

#[test]
fn wrong_identifier_or_expired_deadline_leaves_the_file_untouched() {
    let (mut target, mut image, plan) = fixture(&[0x53; 512]);
    let name = plan.device().display_identifier.clone();
    let live = boottime_ns().unwrap() + 60_000_000_000;
    assert!(
        write_confirmed(
            &mut target,
            live,
            &mut image,
            &plan,
            "WRONG_SYNTHETIC_FIXTURE"
        )
        .is_err()
    );
    assert!(write_confirmed(&mut target, 1, &mut image, &plan, &name).is_err());
    assert!(
        target
            .read_all()
            .unwrap()
            .iter()
            .all(|byte| *byte == SENTINEL)
    );
}
