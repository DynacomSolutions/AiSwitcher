mod flow_support;
mod removal_support;
use ais_host_core::{
    remove::{RemoveOptions, ResumeRemoval, execute_removal, prepare_removal},
    reset,
};
use flow_support::{Fixture, MemoryFlowStore, binding};
use removal_support::FakeRemoval;
use std::{collections::BTreeSet, fs};

#[test]
fn lost_key_reset_is_unavailable_without_reading_a_key_or_requesting_device_authority() {
    let support = reset::support();
    assert!(!support.supported);
    assert!(support.reason.contains("not yet supported"));
    assert!(support.reason.contains("LUKS"));
    assert_eq!(
        reset::require_supported_reset().unwrap_err(),
        support.reason
    );
}

#[test]
fn selecting_erase_reports_unsupported_and_preserves_all_fixture_bytes_and_other_state() {
    let fixture = Fixture::new();
    fixture.common();
    let before_inbox = fs::read(fixture.root.join("inbox/bundle-1.age")).unwrap();
    let before_outbox = fs::read(fixture.root.join("outbox/bundle-1.age")).unwrap();
    let mut backend = FakeRemoval::default();
    let review = prepare_removal(
        binding(),
        RemoveOptions {
            erase_storage: true,
            ..Default::default()
        },
        &mut backend,
        100,
    )
    .unwrap();
    assert!(!review.view().erase_support.supported);
    let digest = review.view().digest.clone();
    let confirmed = review.confirm(&digest, BTreeSet::new(), 101).unwrap();
    let mut store = MemoryFlowStore::default();
    let result = execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval::default(),
    )
    .unwrap();
    assert!(result.erase_storage.failed());
    assert!(!result.forget_drive.completed());
    assert_eq!(backend.forgets, 0);
    assert_eq!(backend.pulls, 0);
    assert!(backend.revokes.is_empty());
    assert_eq!(
        fs::read(fixture.root.join("inbox/bundle-1.age")).unwrap(),
        before_inbox
    );
    assert_eq!(
        fs::read(fixture.root.join("outbox/bundle-1.age")).unwrap(),
        before_outbox
    );
    assert_eq!(store.state.inbox_issued(), 0);
}
