mod escrow_support;
use ais_host_core::{
    escrow::{
        EscrowError, EscrowPolicy, EscrowService, ExposeSecret, RetentionClock, purge_expired,
    },
    registry::EscrowState,
};
use escrow_support::*;

macro_rules! service {
    ($b:ident, $r:ident, $c:ident) => {
        EscrowService::new(&mut $b, &mut $r, &$c)
    };
}

#[test]
fn default_and_import_never_contact_store() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    let record = service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::default(), vec![], None)
        .unwrap();
    assert_eq!(record.escrow_state(), EscrowState::Disabled);
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Missing)
    ));
    let imported = "SYNTHETIC_FIXTURE_imported";
    service!(backend, registry, clock)
        .import_drive(imported, 4, vec![])
        .unwrap();
    assert!(matches!(
        service!(backend, registry, clock).retrieve(imported),
        Err(EscrowError::NotCreator)
    ));
    assert!(matches!(
        service!(backend, registry, clock).reset_drive(
            imported,
            EscrowPolicy::Until(200),
            Some(&secret())
        ),
        Err(EscrowError::NotCreator)
    ));
    assert_eq!((backend.puts, backend.gets, backend.deletes), (0, 0, 0));
}

#[test]
fn explicit_future_expiry_is_required_and_cannot_be_reselected() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    for expiry in [0, 99, 100] {
        assert!(matches!(
            service!(backend, registry, clock).create_drive(
                DRIVE,
                EscrowPolicy::Until(expiry),
                vec![],
                Some(&secret())
            ),
            Err(EscrowError::InvalidRetention)
        ));
    }
    assert!(matches!(
        service!(backend, registry, clock).create_drive(
            DRIVE,
            EscrowPolicy::Until(200),
            vec![],
            None
        ),
        Err(EscrowError::InvalidRetention)
    ));
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Disabled, vec![], None)
        .unwrap();
    assert!(matches!(
        service!(backend, registry, clock).create_drive(
            DRIVE,
            EscrowPolicy::Until(200),
            vec![],
            Some(&secret())
        ),
        Err(EscrowError::AlreadyExists)
    ));
    assert_eq!(backend.puts, 0);
}

#[test]
fn exact_expiry_refuses_without_fetching_and_deletes() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(120), vec![], Some(&secret()))
        .unwrap();
    time.advance(19);
    assert_eq!(
        service!(backend, registry, clock)
            .retrieve(DRIVE)
            .unwrap()
            .expose_secret(),
        PASSPHRASE
    );
    time.advance(1);
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Expired)
    ));
    assert_eq!(backend.gets, 1);
    assert!(backend.values.is_empty());
    assert_eq!(
        registry.data.record(DRIVE).unwrap().escrow_state(),
        EscrowState::Deleted
    );
}

#[test]
fn elapsed_store_call_cannot_release_a_newly_expired_secret() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(120), vec![], Some(&secret()))
        .unwrap();
    backend.delay_get = Some((time, 20));
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Expired)
    ));
    assert!(backend.values.is_empty());
}

#[test]
fn cleanup_after_ui_exit_resume_or_power_off_never_needs_a_read() {
    for restarted in [false, true] {
        let mut backend = FakeStore::default();
        let mut registry = MemoryRegistry::default();
        let time = FakeClock::new(100);
        let clock = RetentionClock::new(time.clone());
        service!(backend, registry, clock)
            .create_drive(DRIVE, EscrowPolicy::Until(120), vec![], Some(&secret()))
            .unwrap();
        time.advance(200);
        let restarted_clock = RetentionClock::new(FakeClock::new(time.wall.get()));
        let result = purge_expired(
            &mut backend,
            &mut registry,
            if restarted { &restarted_clock } else { &clock },
        )
        .unwrap();
        assert_eq!(result.deleted, 1);
        assert_eq!(backend.gets, 0);
        assert!(backend.values.is_empty());
    }
}

#[test]
fn unavailable_cleanup_keeps_tombstone_and_retries_on_availability() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(120), vec![], Some(&secret()))
        .unwrap();
    backend.locked = true;
    time.advance(20);
    let result = purge_expired(&mut backend, &mut registry, &clock).unwrap();
    assert_eq!((result.deleted, result.deletion_pending), (0, 1));
    assert!(registry.data.record(DRIVE).unwrap().item().is_some());
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Expired)
    ));
    assert_eq!(backend.gets, 0);
    backend.locked = false;
    assert_eq!(
        purge_expired(&mut backend, &mut registry, &clock)
            .unwrap()
            .deleted,
        1
    );
    assert!(backend.values.is_empty());
}

#[test]
fn clock_rollback_cannot_extend_monotonic_deadline_or_restart() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(120), vec![], Some(&secret()))
        .unwrap();
    time.advance(10);
    service!(backend, registry, clock).retrieve(DRIVE).unwrap();
    time.wall.set(90);
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::ClockUntrusted)
    ));
    let restarted = RetentionClock::new(FakeClock::new(95));
    assert!(matches!(
        service!(backend, registry, restarted).retrieve(DRIVE),
        Err(EscrowError::ClockUntrusted)
    ));
    assert_eq!(backend.gets, 1);
    time.mono.set(20);
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Expired)
    ));
    assert!(backend.values.is_empty());
}

#[test]
fn failed_put_after_native_success_is_cleaned_up() {
    let mut backend = FakeStore {
        fail_put_after_write: true,
        ..FakeStore::default()
    };
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    assert!(matches!(
        service!(backend, registry, clock).create_drive(
            DRIVE,
            EscrowPolicy::Until(200),
            vec![],
            Some(&secret())
        ),
        Err(EscrowError::Unavailable)
    ));
    assert!(backend.values.is_empty());
    assert_eq!(backend.deletes, 1);
    assert_eq!(
        registry.data.record(DRIVE).unwrap().escrow_state(),
        EscrowState::Deleted
    );
}

#[test]
fn failed_put_and_failed_delete_remain_tracked_for_next_cleanup() {
    let mut backend = FakeStore {
        fail_put_after_write: true,
        fail_delete: true,
        ..FakeStore::default()
    };
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    assert!(matches!(
        service!(backend, registry, clock).create_drive(
            DRIVE,
            EscrowPolicy::Until(200),
            vec![],
            Some(&secret())
        ),
        Err(EscrowError::Unavailable)
    ));
    assert_eq!(backend.values.len(), 1);
    assert_eq!(
        registry.data.record(DRIVE).unwrap().escrow_state(),
        EscrowState::DeletionPending
    );
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Missing)
    ));
    backend.fail_delete = false;
    assert_eq!(
        purge_expired(&mut backend, &mut registry, &clock)
            .unwrap()
            .deleted,
        1
    );
    assert!(backend.values.is_empty());
}

#[test]
fn cleanup_only_deletes_due_or_pending_items() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(120), vec![], Some(&secret()))
        .unwrap();
    let later = "SYNTHETIC_FIXTURE_later";
    service!(backend, registry, clock)
        .create_drive(later, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    assert_eq!(
        purge_expired(&mut backend, &mut registry, &clock)
            .unwrap()
            .next_expiry,
        Some(120)
    );
    assert_eq!(backend.deletes, 0);
    time.advance(20);
    let result = purge_expired(&mut backend, &mut registry, &clock).unwrap();
    assert_eq!(result.deleted, 1);
    assert_eq!(result.next_expiry, Some(200));
    assert_eq!(backend.values.len(), 1);
    assert_eq!(backend.gets, 0);
}

#[test]
fn locked_store_has_no_plaintext_fallback_and_no_fetch() {
    let mut backend = FakeStore {
        locked: true,
        ..FakeStore::default()
    };
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    assert!(matches!(
        service!(backend, registry, clock).create_drive(
            DRIVE,
            EscrowPolicy::Until(200),
            vec![],
            Some(&secret())
        ),
        Err(EscrowError::Locked)
    ));
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Missing)
    ));
    assert!(backend.values.is_empty());
    assert_eq!(backend.gets, 0);
    assert!(
        !serde_json::to_string(&registry.data)
            .unwrap()
            .contains(PASSPHRASE)
    );
}

#[test]
fn reset_changes_generation_reference_and_resets_counters() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    let first = service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    service!(backend, registry, clock)
        .record_refresh(DRIVE, 5, 4, 3)
        .unwrap();
    let second = service!(backend, registry, clock)
        .reset_drive(DRIVE, EscrowPolicy::Until(300), Some(&secret()))
        .unwrap();
    assert_eq!(second.generation(), 2);
    assert_ne!(first.item(), second.item());
    assert_eq!(
        (
            second.inbox_issued(),
            second.inbox_acknowledged(),
            second.outbox_issued()
        ),
        (0, 0, 0)
    );
    assert_eq!(backend.values.len(), 1);
    assert_eq!(backend.deletes, 1);
}

#[test]
fn forget_retains_deletion_intent_until_native_delete_succeeds() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    service!(backend, registry, clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    backend.locked = true;
    assert!(matches!(
        service!(backend, registry, clock).forget(DRIVE),
        Err(EscrowError::DeletionPending)
    ));
    assert!(registry.data.record(DRIVE).is_some());
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::Missing)
    ));
    backend.locked = false;
    purge_expired(&mut backend, &mut registry, &clock).unwrap();
    assert!(registry.data.record(DRIVE).is_none());
    assert!(backend.values.is_empty());
}

#[test]
fn refresh_never_renews_retention_or_rolls_back_sequence() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    service!(backend, registry, clock)
        .create_drive(
            DRIVE,
            EscrowPolicy::Until(200),
            vec!["SYNTHETIC_FIXTURE_source".into()],
            Some(&secret()),
        )
        .unwrap();
    time.advance(10);
    service!(backend, registry, clock)
        .record_refresh(DRIVE, 5, 0, 2)
        .unwrap();
    let record = registry.data.record(DRIVE).unwrap();
    assert_eq!(record.retention(), EscrowPolicy::Until(200));
    assert_eq!(record.last_refresh(), Some(110));
    assert_eq!(record.inbox_acknowledged(), 0);
    for counters in [(4, 0, 2), (5, 6, 2), (5, 0, 1)] {
        assert!(matches!(
            service!(backend, registry, clock)
                .record_refresh(DRIVE, counters.0, counters.1, counters.2),
            Err(EscrowError::InvalidRegistry)
        ));
    }
    assert!(!format!("{:?}", registry.data).contains(PASSPHRASE));
    assert!(!format!("{:?}", secret()).contains(PASSPHRASE));
}

#[test]
fn save_failure_prevents_fetch_and_failed_activation_removes_native_key() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry {
        fail_save: Some(1),
        ..MemoryRegistry::default()
    };
    let clock = RetentionClock::new(FakeClock::new(100));
    assert!(
        service!(backend, registry, clock)
            .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
            .is_err()
    );
    assert_eq!(backend.puts, 0);
    registry.fail_save = Some(3);
    assert!(
        service!(backend, registry, clock)
            .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
            .is_err()
    );
    assert!(backend.values.is_empty());
    service!(backend, registry, clock)
        .reset_drive(DRIVE, EscrowPolicy::Until(200), Some(&secret()))
        .unwrap();
    registry.fail_save = Some(registry.saves + 1);
    assert!(matches!(
        service!(backend, registry, clock).retrieve(DRIVE),
        Err(EscrowError::RegistryUnavailable)
    ));
    assert_eq!(backend.gets, 0);
}
