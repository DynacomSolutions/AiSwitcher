mod escrow_support;
use ais_host_core::{
    escrow::{EscrowError, EscrowPolicy, EscrowService, RetentionClock, purge_expired},
    registry::{EscrowState, FileRegistry, RegistryData, RegistryStorage},
};
use escrow_support::*;
use std::{fs, path::PathBuf};

fn directory() -> PathBuf {
    let mut random = [0; 16];
    getrandom::fill(&mut random).unwrap();
    let path = std::env::temp_dir().join(format!(
        "SYNTHETIC_FIXTURE_escrow_{}",
        ais_host_core::release::hex(&random)
    ));
    fs::create_dir(&path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}

/// Windows test executables are built on Linux, so the compile-time binary path is
/// meaningless where they run; AIS_TEST_BIN_DIR points at the copied binaries instead.
fn built_binary(name: &str, compiled: &str) -> std::path::PathBuf {
    std::env::var_os("AIS_TEST_BIN_DIR").map_or_else(
        || compiled.into(),
        |dir| std::path::Path::new(&dir).join(format!("{name}{}", std::env::consts::EXE_SUFFIX)),
    )
}

#[test]
fn records_survive_restart_without_secret_material() {
    let directory = directory();
    let mut backend = FakeStore::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    {
        let mut registry = FileRegistry::open(&directory).unwrap();
        EscrowService::new(&mut backend, &mut registry, &clock)
            .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
            .unwrap();
        EscrowService::new(&mut backend, &mut registry, &clock)
            .record_refresh(DRIVE, 4, 2, 1)
            .unwrap();
        assert!(matches!(
            FileRegistry::open(&directory),
            Err(EscrowError::RegistryBusy)
        ));
    }
    let encoded = fs::read_to_string(directory.join("drives.json")).unwrap();
    assert!(!encoded.contains(PASSPHRASE));
    let mut registry = FileRegistry::open(&directory).unwrap();
    let data = registry.load().unwrap();
    let record = data.record(DRIVE).unwrap();
    assert_eq!(record.generation(), 1);
    assert_eq!(record.created_at(), 100);
    assert_eq!(record.last_refresh(), Some(100));
    assert_eq!(record.inbox_acknowledged(), 2);
    let clock = RetentionClock::new(FakeClock::new(201));
    assert_eq!(
        purge_expired(&mut backend, &mut registry, &clock)
            .unwrap()
            .deleted,
        1
    );
    assert_eq!(backend.gets, 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(directory.join("drives.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn interrupted_creation_is_purged_before_any_retrieval() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    let mut json = serde_json::to_value(&registry.data).unwrap();
    json["drives"][DRIVE]["escrowState"] = "pendingWrite".into();
    registry.data = serde_json::from_value(json).unwrap();
    assert!(matches!(
        EscrowService::new(&mut backend, &mut registry, &clock).retrieve(DRIVE),
        Err(EscrowError::Missing)
    ));
    assert_eq!(
        purge_expired(&mut backend, &mut registry, &clock)
            .unwrap()
            .deleted,
        1
    );
    assert!(backend.values.is_empty());
    assert_eq!(backend.gets, 0);
}

#[test]
fn corrupt_or_missing_scope_cannot_select_arbitrary_native_item() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    let original = serde_json::to_value(&registry.data).unwrap();
    for field in [
        "item",
        "generation",
        "createdHere",
        "inboxAcknowledged",
        "driveId",
    ] {
        let mut corrupted = original.clone();
        corrupted["drives"][DRIVE][field] = match field {
            "item" => "a".repeat(64).into(),
            "generation" => 0.into(),
            "createdHere" => false.into(),
            "inboxAcknowledged" => 99.into(),
            _ => "SYNTHETIC_FIXTURE_other".into(),
        };
        let data: RegistryData = serde_json::from_value(corrupted).unwrap();
        assert_eq!(data.validate(), Err(EscrowError::InvalidRegistry));
    }
    let mut unexpected = original.clone();
    unexpected["passphrase"] = PASSPHRASE.into();
    assert!(serde_json::from_value::<RegistryData>(unexpected).is_err());
    assert_eq!(backend.gets, 0);
}

#[test]
fn independent_installations_have_different_native_references() {
    let mut backend = FakeStore::default();
    let mut first = MemoryRegistry::default();
    let mut second = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    let a = EscrowService::new(&mut backend, &mut first, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    let b = EscrowService::new(&mut backend, &mut second, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    assert_ne!(a.item(), b.item());
    assert_eq!(backend.values.len(), 2);
}

#[test]
fn persisted_delete_is_idempotent_after_lost_final_registry_save() {
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let time = FakeClock::new(100);
    let clock = RetentionClock::new(time.clone());
    EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(DRIVE, EscrowPolicy::Until(200), vec![], Some(&secret()))
        .unwrap();
    time.advance(100);
    registry.fail_save = Some(registry.saves + 2);
    assert!(matches!(
        purge_expired(&mut backend, &mut registry, &clock),
        Err(EscrowError::RegistryUnavailable)
    ));
    assert!(backend.values.is_empty());
    assert_eq!(
        registry.data.record(DRIVE).unwrap().escrow_state(),
        EscrowState::DeletionPending
    );
    assert_eq!(
        purge_expired(&mut backend, &mut registry, &clock)
            .unwrap()
            .deleted,
        1
    );
}

#[test]
fn invalid_json_is_not_replaced_by_an_empty_registry() {
    let directory = directory();
    fs::write(directory.join("drives.json"), b"{").unwrap();
    let mut registry = FileRegistry::open(&directory).unwrap();
    assert!(matches!(registry.load(), Err(EscrowError::InvalidRegistry)));
    assert_eq!(fs::read(directory.join("drives.json")).unwrap(), b"{");
}

#[test]
fn cleanup_executable_runs_without_ui_or_store_for_an_empty_registry() {
    let directory = directory();
    let output = std::process::Command::new(built_binary(
        "ais-host-escrow-purge",
        env!("CARGO_BIN_EXE_ais-host-escrow-purge"),
    ))
    .arg("--once")
    .arg(&directory)
    .output()
    .unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    let mut registry = FileRegistry::open(&directory).unwrap();
    assert_eq!(registry.load().unwrap().records().count(), 0);
}

#[test]
fn cleanup_executable_fails_closed_on_corrupt_registry() {
    let directory = directory();
    fs::write(directory.join("drives.json"), b"{").unwrap();
    let output = std::process::Command::new(built_binary(
        "ais-host-escrow-purge",
        env!("CARGO_BIN_EXE_ais-host-escrow-purge"),
    ))
    .arg("--once")
    .arg(&directory)
    .output()
    .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        EscrowError::InvalidRegistry.to_string()
    );
}

#[cfg(unix)]
#[test]
fn shared_directory_and_symlink_registry_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = directory();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        FileRegistry::open(&directory),
        Err(EscrowError::InvalidRegistry)
    ));
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let target = directory.join("SYNTHETIC_FIXTURE_target");
    fs::write(&target, b"{}").unwrap();
    symlink(&target, directory.join("drives.json")).unwrap();
    let mut registry = FileRegistry::open(&directory).unwrap();
    assert!(matches!(registry.load(), Err(EscrowError::InvalidRegistry)));
    assert!(matches!(
        registry.save(&RegistryData::new().unwrap()),
        Err(EscrowError::InvalidRegistry)
    ));
    assert_eq!(fs::read(target).unwrap(), b"{}");
}
