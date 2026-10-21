//! Run with --nocapture to see an explicit unsupported result. Native CI sets
//! AIS_REQUIRE_NATIVE_ESCROW=1 so an absent store fails the job. Only uniquely
//! scoped synthetic items created by this test are deleted.
mod escrow_support;
use ais_host_core::escrow::{
    EscrowDelete, EscrowPolicy, EscrowService, ExposeSecret, ItemRef, RetentionClock,
    native::NativeStore,
};
use escrow_support::*;

struct Cleanup(Option<ItemRef>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(item) = &self.0
            && NativeStore.delete(item).is_err()
        {
            eprintln!("NATIVE_ESCROW_CLEANUP_PENDING: synthetic test item deletion failed");
        }
    }
}

#[test]
fn native_store_round_trip_and_delete() {
    let mut backend = NativeStore;
    if let Err(error) = backend.availability() {
        eprintln!("NATIVE_ESCROW_UNSUPPORTED: {error}");
        assert!(
            std::env::var_os("AIS_REQUIRE_NATIVE_ESCROW").is_none(),
            "Native credential store is required for this run"
        );
        return;
    }
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    let record = EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    let mut cleanup = Cleanup(record.item().cloned());
    assert_eq!(
        EscrowService::new(&mut backend, &mut registry, &clock)
            .retrieve(DRIVE)
            .unwrap()
            .expose_secret(),
        PASSPHRASE
    );
    EscrowService::new(&mut backend, &mut registry, &clock)
        .delete(DRIVE)
        .unwrap();
    // Verify the store itself, without relying on the metadata state.
    use ais_host_core::escrow::{EscrowError, EscrowStore};
    assert!(matches!(
        backend.retrieve(cleanup.0.as_ref().unwrap()),
        Err(EscrowError::Missing)
    ));
    cleanup.0 = None;
    eprintln!("NATIVE_ESCROW_VERIFIED: write, read and deletion passed");
}
