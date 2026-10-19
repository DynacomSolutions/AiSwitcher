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

/// Sign this test executable with the app entitlements and the separate helper
/// with the helper entitlements, using the same team and distinct app IDs. Set
/// AIS_ESCROW_SIGNED_HELPER to that helper and AIS_REQUIRE_NATIVE_ESCROW=1.
#[cfg(target_os = "macos")]
#[test]
fn signed_creator_item_is_deleted_by_separate_helper_without_deleting_other_items() {
    use ais_host_core::{
        escrow::{EscrowError, EscrowStore},
        registry::{EscrowState, FileRegistry, RegistryStorage},
    };
    use std::{
        fs,
        os::unix::fs::DirBuilderExt,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    let Some(helper) = std::env::var_os("AIS_ESCROW_SIGNED_HELPER") else {
        eprintln!("NATIVE_ESCROW_UNSUPPORTED: separate signed cleanup helper is required");
        assert!(
            std::env::var_os("AIS_REQUIRE_NATIVE_ESCROW").is_none(),
            "Signed helper is required for this run"
        );
        return;
    };
    let mut backend = NativeStore;
    backend
        .availability()
        .expect("Creator must have the shared signed entitlement");
    let mut random = [0; 16];
    getrandom::fill(&mut random).unwrap();
    let directory = std::env::temp_dir().join(format!(
        "SYNTHETIC_FIXTURE_signed_escrow_{}",
        ais_host_core::release::hex(&random)
    ));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let clock = RetentionClock::new(FakeClock::new(now - 100));
    let mut registry = FileRegistry::open(&directory).unwrap();
    let due = EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(now - 1), vec![], Some(&secret()))
        .unwrap();
    let mut due_cleanup = Cleanup(due.item().cloned());
    // A separate installation reference proves the helper cannot delete all
    // items in the shared service/group when only one registry authorises it.
    let mut other_registry = MemoryRegistry::default();
    let other = EscrowService::new(&mut backend, &mut other_registry, &clock)
        .create_drive(
            "SYNTHETIC_FIXTURE_unrelated",
            EscrowPolicy::Until(now + 3_600),
            vec![],
            Some(&secret()),
        )
        .unwrap();
    let other_cleanup = Cleanup(other.item().cloned());
    assert!(backend.retrieve(due.item().unwrap()).is_ok());
    drop(registry);

    // Native errors and paths are never printed. Only this child is awaited.
    let output = Command::new(helper)
        .arg("--once")
        .arg(&directory)
        .output()
        .unwrap();
    assert!(output.status.success(), "Signed cleanup helper failed");
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert!(matches!(
        backend.retrieve(due.item().unwrap()),
        Err(EscrowError::Missing)
    ));
    assert!(
        backend
            .retrieve(other.item().unwrap())
            .unwrap()
            .expose_secret()
            == PASSPHRASE,
        "Unrelated synthetic item changed"
    );
    let mut registry = FileRegistry::open(&directory).unwrap();
    assert_eq!(
        registry
            .load()
            .unwrap()
            .record(DRIVE)
            .unwrap()
            .escrow_state(),
        EscrowState::Deleted
    );
    due_cleanup.0 = None;
    drop(other_cleanup);
    eprintln!("NATIVE_ESCROW_VERIFIED: separate signed helper deleted only its authorised item");
}
