use ais_host_core::{
    contract::MAX_SAFE_SEQUENCE,
    sequence::{SequenceCoordinator, SequenceHighWater},
};

#[test]
fn reservation_is_monotone_and_tracks_inbox_and_outbox_separately() {
    let coordinator = SequenceCoordinator::new(SequenceHighWater::new(8, 2).unwrap());
    assert_eq!(coordinator.reserve_inbox(10, 7, |_| Ok(())).unwrap(), 11);
    assert_eq!(coordinator.reserve_outbox(5, |_| Ok(())).unwrap(), 6);
    let state = coordinator.snapshot().unwrap();
    assert_eq!(state.inbox_issued(), 11);
    assert_eq!(state.outbox_issued(), 6);
}

#[test]
fn persistence_failure_does_not_advance_the_reserved_high_water_mark() {
    let coordinator = SequenceCoordinator::new(SequenceHighWater::default());
    assert!(
        coordinator
            .reserve_inbox(0, 0, |_| Err("synthetic persistence failure".into()))
            .is_err()
    );
    assert_eq!(coordinator.reserve_inbox(0, 0, |_| Ok(())).unwrap(), 1);
}

#[test]
fn refuses_values_above_javascript_safe_integer_limit() {
    let coordinator =
        SequenceCoordinator::new(SequenceHighWater::new(MAX_SAFE_SEQUENCE, 0).unwrap());
    assert!(coordinator.reserve_inbox(0, 0, |_| Ok(())).is_err());
    assert!(SequenceHighWater::new(MAX_SAFE_SEQUENCE + 1, 0).is_err());
}
