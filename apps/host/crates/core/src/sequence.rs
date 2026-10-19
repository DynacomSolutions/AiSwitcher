use crate::{bundle::BundleOperationLock, contract::MAX_SAFE_SEQUENCE};
use std::sync::Mutex;

/// Per-drive sequence counters. These values are local state only; load durable
/// state after acquiring `BundleOperationLock` before issuing a reservation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SequenceHighWater {
    inbox_issued: u64,
    outbox_issued: u64,
}

/// A single coordinator is shared by all operations for one drive. It serialises
/// reservation and persistence so concurrent writers cannot claim the same seq.
pub struct SequenceCoordinator {
    state: Mutex<SequenceHighWater>,
}

impl SequenceCoordinator {
    pub fn new(state: SequenceHighWater) -> Self {
        Self {
            state: Mutex::new(state),
        }
    }

    /// Persists a reservation and runs publication while the caller's
    /// cross-process operation lock and this coordinator's mutex are held. A
    /// failed operation consumes the durably issued sequence.
    pub fn with_inbox_reservation<F, G, T>(
        &self,
        _operation_lock: &BundleOperationLock,
        authenticated_acknowledged: u64,
        authenticated_existing_inbox: u64,
        persist_issued: F,
        operation: G,
    ) -> Result<T, String>
    where
        F: FnOnce(u64) -> Result<(), String>,
        G: FnOnce(u64) -> Result<T, String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "drive sequence lock is poisoned")?;
        let next = state
            .inbox_issued
            .max(authenticated_acknowledged)
            .max(authenticated_existing_inbox)
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .ok_or_else(|| "inbox sequence space is exhausted".to_owned())?;
        persist_issued(next)?;
        state.inbox_issued = next;
        operation(next)
    }

    /// Persists a reservation and publishes while both locks are held.
    pub fn with_outbox_reservation<F, G, T>(
        &self,
        _operation_lock: &BundleOperationLock,
        authenticated_existing_outbox: u64,
        persist_issued: F,
        operation: G,
    ) -> Result<T, String>
    where
        F: FnOnce(u64) -> Result<(), String>,
        G: FnOnce(u64) -> Result<T, String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "drive sequence lock is poisoned")?;
        let next = state
            .outbox_issued
            .max(authenticated_existing_outbox)
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .ok_or_else(|| "outbox sequence space is exhausted".to_owned())?;
        persist_issued(next)?;
        state.outbox_issued = next;
        operation(next)
    }

    /// Arithmetic-only local reservation helper. Persistent application flows
    /// must use `with_inbox_reservation` under `BundleOperationLock`.
    pub fn reserve_inbox<F>(
        &self,
        authenticated_acknowledged: u64,
        authenticated_existing_inbox: u64,
        persist_issued: F,
    ) -> Result<u64, String>
    where
        F: FnOnce(u64) -> Result<(), String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "drive sequence lock is poisoned")?;
        let next = state
            .inbox_issued
            .max(authenticated_acknowledged)
            .max(authenticated_existing_inbox)
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .ok_or_else(|| "inbox sequence space is exhausted".to_owned())?;
        persist_issued(next)?;
        state.inbox_issued = next;
        Ok(next)
    }

    /// Arithmetic-only local reservation helper. Persistent application flows
    /// must use `with_outbox_reservation` under `BundleOperationLock`.
    pub fn reserve_outbox<F>(
        &self,
        authenticated_existing_outbox: u64,
        persist_issued: F,
    ) -> Result<u64, String>
    where
        F: FnOnce(u64) -> Result<(), String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "drive sequence lock is poisoned")?;
        let next = state
            .outbox_issued
            .max(authenticated_existing_outbox)
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .ok_or_else(|| "outbox sequence space is exhausted".to_owned())?;
        persist_issued(next)?;
        state.outbox_issued = next;
        Ok(next)
    }

    pub fn snapshot(&self) -> Result<SequenceHighWater, String> {
        self.state
            .lock()
            .map(|state| *state)
            .map_err(|_| "drive sequence lock is poisoned".into())
    }
}

impl SequenceHighWater {
    pub fn new(inbox_issued: u64, outbox_issued: u64) -> Result<Self, String> {
        validate_sequence(inbox_issued)?;
        validate_sequence(outbox_issued)?;
        Ok(Self {
            inbox_issued,
            outbox_issued,
        })
    }

    /// Arithmetic-only local helper. Persistent flows should use
    /// `SequenceCoordinator::with_inbox_reservation` while holding the bundle
    /// operation lock and after loading durable counters under that lock.
    pub fn reserve_inbox(
        &mut self,
        authenticated_acknowledged: u64,
        authenticated_existing_inbox: u64,
    ) -> Result<u64, String> {
        validate_sequence(authenticated_acknowledged)?;
        validate_sequence(authenticated_existing_inbox)?;
        let next = self
            .inbox_issued
            .max(authenticated_acknowledged)
            .max(authenticated_existing_inbox)
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .ok_or_else(|| "inbox sequence space is exhausted".to_owned())?;
        self.inbox_issued = next;
        Ok(next)
    }

    /// Arithmetic-only local helper. Persistent flows should use
    /// `SequenceCoordinator::with_outbox_reservation` under the same lock.
    pub fn reserve_outbox(&mut self, authenticated_existing_outbox: u64) -> Result<u64, String> {
        validate_sequence(authenticated_existing_outbox)?;
        let next = self
            .outbox_issued
            .max(authenticated_existing_outbox)
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_SEQUENCE)
            .ok_or_else(|| "outbox sequence space is exhausted".to_owned())?;
        self.outbox_issued = next;
        Ok(next)
    }

    pub fn inbox_issued(&self) -> u64 {
        self.inbox_issued
    }
    pub fn outbox_issued(&self) -> u64 {
        self.outbox_issued
    }
}

pub fn validate_sequence(value: u64) -> Result<(), String> {
    if value > MAX_SAFE_SEQUENCE {
        Err("sequence exceeds the JavaScript safe integer range".into())
    } else {
        Ok(())
    }
}

/// Adopts state on another computer only from authenticated exchange bundles.
/// Missing state on both independent sides is ambiguous after local registry loss.
pub fn recover_from_authenticated_exchange(
    inbox_sequence: Option<u64>,
    outbox_sequence: Option<u64>,
) -> Result<SequenceHighWater, String> {
    if inbox_sequence.is_none() && outbox_sequence.is_none() {
        return Err(
            "authenticated exchange state is missing; refusing ambiguous sequence recovery".into(),
        );
    }
    SequenceHighWater::new(inbox_sequence.unwrap_or(0), outbox_sequence.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_operation_lock() -> BundleOperationLock {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ais-sequence-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        crate::bundle::acquire_bundle_operation_lock(&directory).unwrap()
    }

    #[test]
    fn reserves_above_all_authenticated_and_local_inbox_state() {
        let mut state = SequenceHighWater::new(4, 12).unwrap();
        assert_eq!(state.reserve_inbox(8, 11).unwrap(), 12);
        assert_eq!(state.reserve_inbox(5, 3).unwrap(), 13);
        assert_eq!(state.outbox_issued(), 12);
    }

    #[test]
    fn counters_are_independent_and_do_not_use_time() {
        let mut state = SequenceHighWater::default();
        assert_eq!(state.reserve_outbox(6).unwrap(), 7);
        assert_eq!(state.reserve_inbox(0, 0).unwrap(), 1);
        assert_eq!(state.reserve_outbox(0).unwrap(), 8);
    }

    #[test]
    fn rejects_exhausted_and_unsafe_values_without_mutating_state() {
        let mut state = SequenceHighWater::new(MAX_SAFE_SEQUENCE, 0).unwrap();
        assert!(state.reserve_inbox(0, 0).is_err());
        assert_eq!(state.inbox_issued(), MAX_SAFE_SEQUENCE);
        assert!(SequenceHighWater::new(MAX_SAFE_SEQUENCE + 1, 0).is_err());
        assert!(validate_sequence(MAX_SAFE_SEQUENCE + 1).is_err());
    }

    #[test]
    fn coordinator_serialises_reservations_and_persists_before_returning() {
        use std::sync::Arc;
        let coordinator = Arc::new(SequenceCoordinator::new(SequenceHighWater::default()));
        let mut threads = Vec::new();
        for _ in 0..16 {
            let coordinator = Arc::clone(&coordinator);
            threads.push(std::thread::spawn(move || {
                coordinator.reserve_inbox(0, 0, |_| Ok(())).unwrap()
            }));
        }
        let mut reserved = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        reserved.sort_unstable();
        assert_eq!(reserved, (1..=16).collect::<Vec<_>>());
        assert_eq!(coordinator.snapshot().unwrap().inbox_issued(), 16);
    }

    #[test]
    fn failed_persistence_does_not_issue_a_sequence() {
        let coordinator = SequenceCoordinator::new(SequenceHighWater::default());
        assert!(
            coordinator
                .reserve_outbox(0, |_| Err("disk full".into()))
                .is_err()
        );
        assert_eq!(coordinator.reserve_outbox(0, |_| Ok(())).unwrap(), 1);
    }

    #[test]
    fn failed_publication_keeps_the_durably_reserved_sequence_consumed() {
        let coordinator = SequenceCoordinator::new(SequenceHighWater::default());
        let operation_lock = test_operation_lock();
        assert!(
            coordinator
                .with_inbox_reservation(
                    &operation_lock,
                    0,
                    0,
                    |_| Ok(()),
                    |_| { Err::<(), _>("publish failed".into()) }
                )
                .is_err()
        );
        assert_eq!(coordinator.snapshot().unwrap().inbox_issued(), 1);
        assert_eq!(
            coordinator
                .with_inbox_reservation(
                    &operation_lock,
                    0,
                    0,
                    |_| Ok(()),
                    |sequence| { Ok(sequence) }
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn registry_loss_requires_authenticated_exchange_state() {
        assert!(recover_from_authenticated_exchange(None, None).is_err());
        let recovered = recover_from_authenticated_exchange(Some(9), Some(4)).unwrap();
        assert_eq!(recovered.inbox_issued(), 9);
        assert_eq!(recovered.outbox_issued(), 4);
    }
}
