#![cfg(feature = "file-test")]
use ais_host_core::{
    device::{ConfirmationBook, WriteFailure, WritePlan, WriteTarget, write_image},
    file_test::{FileTarget, SyntheticRelease, run_write_safety},
};
use std::time::{Duration, Instant};

#[test]
fn all_refusals_preserve_bytes_and_faults_preserve_outside_sentinels() {
    assert_eq!(run_write_safety(&std::env::temp_dir()).unwrap(), 26);
}

#[test]
fn a_second_app_session_cannot_use_another_sessions_ticket() {
    let fixture = SyntheticRelease::new(vec![0x45; 512]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut first = ConfirmationBook::default();
    let mut second = ConfirmationBook::default();
    let now = Instant::now();
    let ticket = first
        .issue(
            &plan,
            &observation.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap();
    let before = target.read_all().unwrap();
    assert!(matches!(
        write_image(
            &mut target,
            &mut image,
            &plan,
            &mut second,
            &ticket,
            now,
            || false
        ),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(target.read_all().unwrap(), before);
}

#[test]
fn target_path_reuse_is_rejected_before_mutation() {
    let fixture = SyntheticRelease::new(vec![0x45; 512]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut book = ConfirmationBook::default();
    let now = Instant::now();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap();
    let before = target.read_all().unwrap();
    let moved = target.path().with_extension("retained");
    std::fs::rename(target.path(), moved).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target.path())
        .unwrap();
    assert!(matches!(
        write_image(
            &mut target,
            &mut image,
            &plan,
            &mut book,
            &ticket,
            now,
            || false
        ),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(target.read_all().unwrap(), before);
    assert_eq!(std::fs::metadata(target.path()).unwrap().len(), 0);
}

#[cfg(unix)]
#[test]
fn target_symlink_swap_cannot_redirect_the_writer() {
    let fixture = SyntheticRelease::new(vec![0x45; 512]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let mut other = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut book = ConfirmationBook::default();
    let now = Instant::now();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap();
    let before = target.read_all().unwrap();
    std::fs::rename(target.path(), target.path().with_extension("retained")).unwrap();
    std::os::unix::fs::symlink(other.path(), target.path()).unwrap();
    assert!(matches!(
        write_image(
            &mut target,
            &mut image,
            &plan,
            &mut book,
            &ticket,
            now,
            || false
        ),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(target.read_all().unwrap(), before);
    assert_eq!(other.read_all().unwrap(), before);
}
