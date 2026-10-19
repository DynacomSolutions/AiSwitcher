mod escrow_support;
mod flow_support;
mod removal_support;
use ais_host_core::{
    escrow::{EscrowPolicy, EscrowService, RetentionClock},
    flow_state::{FileFlowStore, FlowStore},
    registry::FileRegistry,
};
use escrow_support::{FakeClock, FakeStore};
use flow_support::{binding, directory};
use std::fs;

#[test]
fn file_store_seeds_existing_counters_locks_operations_and_persists_without_secrets() {
    let directory = directory();
    let mut backend = FakeStore::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    {
        let mut registry = FileRegistry::open(&directory).unwrap();
        let mut service = EscrowService::new(&mut backend, &mut registry, &clock);
        service
            .create_drive(flow_support::DRIVE, EscrowPolicy::Disabled, vec![], None)
            .unwrap();
        service
            .record_refresh(flow_support::DRIVE, 4, 2, 7)
            .unwrap();
    }
    {
        let mut store = FileFlowStore::open(directory.clone()).unwrap();
        let state = store.load(&binding()).unwrap();
        assert_eq!(state.inbox_issued(), 4);
        assert_eq!(state.inbox_acknowledged(), 2);
        assert_eq!(state.outbox_issued(), 7);
        assert!(FileFlowStore::open(directory.clone()).is_err());
        store.save(&state).unwrap();
    }
    let mut store = FileFlowStore::open(directory.clone()).unwrap();
    let state = store.load(&binding()).unwrap();
    assert_eq!(state.inbox_issued(), 4);
    let file = directory.join("flows/SYNTHETIC_FIXTURE_drive-1.json");
    assert!(
        !fs::read_to_string(&file)
            .unwrap()
            .contains(flow_support::SECRET)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn file_store_rejects_symlinked_state_and_non_private_directories() {
    use std::os::unix::{fs::PermissionsExt, fs::symlink};
    let directory = directory();
    let mut store = FileFlowStore::open(directory.clone()).unwrap();
    let outside = directory.join("SYNTHETIC_FIXTURE_external.json");
    fs::write(&outside, b"{}").unwrap();
    symlink(
        &outside,
        directory.join("flows/SYNTHETIC_FIXTURE_drive-1.json"),
    )
    .unwrap();
    assert!(store.load(&binding()).is_err());
    drop(store);
    fs::set_permissions(directory.join("flows"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(FileFlowStore::open(directory).is_err());
}

#[test]
fn retained_failure_journals_can_be_resolved_after_forgetting_and_reopening() {
    use ais_host_core::remove::{RemoveOptions, ResumeRemoval, execute_removal, prepare_removal};
    use std::collections::BTreeSet;
    let directory = directory();
    let clock = RetentionClock::new(FakeClock::new(100));
    let mut escrow = FakeStore::default();
    {
        let mut registry = FileRegistry::open(&directory).unwrap();
        EscrowService::new(&mut escrow, &mut registry, &clock)
            .create_drive(flow_support::DRIVE, EscrowPolicy::Disabled, vec![], None)
            .unwrap();
    }
    let mut backend = removal_support::FakeRemoval::default();
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
    let digest = review.view().digest.clone();
    let confirmed = review.confirm(&digest, BTreeSet::new(), 101).unwrap();
    {
        let mut store = FileFlowStore::open(directory.clone()).unwrap();
        let result = execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval::default(),
        )
        .unwrap();
        assert!(result.erase_storage.failed());
    }
    {
        let mut registry = FileRegistry::open(&directory).unwrap();
        EscrowService::new(&mut escrow, &mut registry, &clock)
            .forget(flow_support::DRIVE)
            .unwrap();
    }
    let mut reopened = FileFlowStore::open(directory).unwrap();
    assert_eq!(reopened.retained_removal_bindings().unwrap(), [binding()]);
    let state = reopened.load(&binding()).unwrap();
    assert!(!state.removal().unwrap().failures_seen());
    assert_eq!(state.removal().unwrap().review_digest(), digest);
}
