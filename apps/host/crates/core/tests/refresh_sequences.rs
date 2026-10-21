mod flow_support;
use ais_host_core::{
    contract::{BundleKind, MAX_SAFE_SEQUENCE, sha256_hex},
    escrow::SecretString,
    exchange::MountedExchange,
    flow_state::{DriveBinding, FlowState, FlowStore},
    refresh::{
        RefreshChoices, RefreshDisposition, adopt_authenticated_exchange, prepare_refresh,
        publish_refresh, reconcile,
    },
};
use flow_support::*;
use std::fs;

#[test]
fn publication_stays_pending_reuses_identical_inputs_and_requires_review_for_replacement() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[(CONFIG, b"new"), (AUTH, b"SYNTHETIC_FIXTURE_token")]);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert_eq!(preview.view().disposition, RefreshDisposition::Ready);
    assert_eq!(store.state.common_hashes()[CONFIG], sha256_hex(b"old"));
    let result = publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED).unwrap();
    assert_eq!(result.sequence, Some(2));
    assert!(!result.acknowledged);
    assert_eq!(store.state.inbox_acknowledged(), 1);
    assert_eq!(store.state.common_hashes()[CONFIG], sha256_hex(b"old"));
    store.state = store.load(&binding()).unwrap();
    let again = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert_eq!(again.view().disposition, RefreshDisposition::ReusePending);
    assert!(
        publish_refresh(again, &exchange, &mut store, &mut adapter, CAPTURED)
            .unwrap()
            .reused_pending
    );
    adapter.source = tar(
        BundleKind::Inbox,
        1,
        0,
        &[(CONFIG, b"newer"), (AUTH, b"SYNTHETIC_FIXTURE_token")],
        false,
    );
    let wait = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert_eq!(
        wait.view().disposition,
        RefreshDisposition::AwaitingAcknowledgement
    );
    assert!(publish_refresh(wait, &exchange, &mut store, &mut adapter, CAPTURED).is_err());
    assert_eq!(store.state.inbox_issued(), 2);
    let replacement = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices {
            replace_pending: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(replacement.view().replaces_pending);
    assert_eq!(
        publish_refresh(replacement, &exchange, &mut store, &mut adapter, CAPTURED)
            .unwrap()
            .sequence,
        Some(3)
    );
    fixture.write(
        BundleKind::Outbox,
        2,
        3,
        &[(CONFIG, b"drive-kept-its-edit")],
        false,
    );
    let after_ack = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert_eq!(after_ack.view().acknowledged_seq, 3);
    assert_eq!(after_ack.view().pending_seq, None);
    assert_eq!(store.state.common_hashes()[CONFIG], sha256_hex(b"old"));
    assert_eq!(after_ack.view().conflicts.len(), 1);
}

#[test]
fn only_authenticated_acknowledgement_with_matching_path_hashes_promotes_common_state() {
    let fixture = Fixture::new();
    fixture.write(
        BundleKind::Inbox,
        7,
        0,
        &[(CONFIG, b"applied"), (".ais/identities.json", b"deferred")],
        false,
    );
    fixture.write(
        BundleKind::Outbox,
        2,
        7,
        &[(CONFIG, b"applied"), (".ais/identities.json", b"older")],
        false,
    );
    let exchange = fixture.exchange();
    let mut state = adopt_authenticated_exchange(&exchange.snapshot().unwrap()).unwrap();
    assert_eq!(state.inbox_issued(), 7);
    assert_eq!(state.outbox_issued(), 2);
    assert_eq!(state.common_hashes().len(), 1);
    assert_eq!(state.common_hashes()[CONFIG], sha256_hex(b"applied"));
    fixture.write(
        BundleKind::Outbox,
        2,
        7,
        &[(CONFIG, b"forged-same-sequence")],
        false,
    );
    assert!(reconcile(&mut state, &exchange.snapshot().unwrap()).is_err());
    let wrong_generation = DriveBinding::new(DRIVE, 2).unwrap();
    let other = MountedExchange::open(
        fixture.root.clone(),
        "drive.json",
        wrong_generation,
        SecretString::from(SECRET),
    )
    .unwrap();
    assert!(reconcile(&mut state, &other.snapshot().unwrap()).is_err());
    let empty = Fixture::new();
    assert!(adopt_authenticated_exchange(&empty.exchange().snapshot().unwrap()).is_err());
}

#[test]
fn lower_outbox_does_not_roll_back_counters_or_promote_hashes() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut state = adopt_authenticated_exchange(&exchange.snapshot().unwrap()).unwrap();
    fixture.write(BundleKind::Outbox, 3, 2, &[(CONFIG, b"drive")], false);
    reconcile(&mut state, &exchange.snapshot().unwrap()).unwrap();
    // Removing only this synthetic fixture simulates an older mounted snapshot.
    fs::rename(
        fixture.root.join("outbox/bundle-3.age"),
        fixture.root.join("saved-outbox.age"),
    )
    .unwrap();
    reconcile(&mut state, &exchange.snapshot().unwrap()).unwrap();
    assert_eq!(state.outbox_issued(), 3);
    assert_eq!(state.inbox_acknowledged(), 2);
    assert_eq!(state.common_hashes()[CONFIG], sha256_hex(b"old"));
}

#[test]
fn newer_outbox_with_regressed_acknowledgement_is_not_a_clean_config_preview() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore {
        state: adopt_authenticated_exchange(&exchange.snapshot().unwrap()).unwrap(),
        ..Default::default()
    };
    fixture.write(BundleKind::Outbox, 2, 0, &[(CONFIG, b"old")], false);
    let mut adapter = FakeAdapter::new(&[(CONFIG, b"new")]);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert!(!preview.view().outbox_current);
    assert_eq!(preview.view().conflicts.len(), 1);
    assert_eq!(
        preview.view().disposition,
        RefreshDisposition::NoSafeEntries
    );
    assert_eq!(store.state.inbox_acknowledged(), 1);
    assert_eq!(store.state.common_hashes()[CONFIG], sha256_hex(b"old"));
}

#[test]
fn source_or_exchange_changes_invalidate_preview_before_reservation() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[(CONFIG, b"new")]);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    adapter.source = tar(BundleKind::Inbox, 1, 0, &[(CONFIG, b"changed")], false);
    assert!(
        publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED)
            .unwrap_err()
            .contains("source changed")
    );
    assert_eq!(store.state.inbox_issued(), 1);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    fixture.write(
        BundleKind::Outbox,
        2,
        1,
        &[(CONFIG, b"concurrent drive edit")],
        false,
    );
    assert!(
        publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED)
            .unwrap_err()
            .contains("exchange changed")
    );
    assert_eq!(store.state.inbox_issued(), 1);
}

#[test]
fn reservations_survive_publication_failure_and_sequences_are_never_reused() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[(CONFIG, b"new")]);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    store.fail_save = Some(store.saves + 1);
    assert!(publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED).is_err());
    assert!(!fixture.root.join("inbox/bundle-2.age").exists());
    assert_eq!(store.state.inbox_issued(), 1);
    store.fail_save = None;
    fs::write(
        fixture.root.join("inbox/.bundle-2.age.tmp"),
        b"SYNTHETIC_FIXTURE interrupted operation",
    )
    .unwrap();
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert!(publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED).is_err());
    assert_eq!(store.state.inbox_issued(), 2);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert_eq!(
        publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED)
            .unwrap()
            .sequence,
        Some(3)
    );
    assert_eq!(store.state.inbox_acknowledged(), 1);
}

#[test]
fn unsafe_or_forged_exchange_never_authorises_refresh() {
    let fixture = Fixture::new();
    fixture.common();
    let path = fixture.root.join("outbox/bundle-1.age");
    let mut bytes = fs::read(&path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(path, bytes).unwrap();
    assert!(fixture.exchange().snapshot().is_err());
    fs::write(
        fixture.root.join("drive.json"),
        br#"{"driveId":"SYNTHETIC_FIXTURE_another_drive"}"#,
    )
    .unwrap();
    assert!(
        MountedExchange::open(
            fixture.root.clone(),
            "drive.json",
            binding(),
            SecretString::from(SECRET)
        )
        .is_err()
    );
    #[cfg(unix)]
    {
        let linked = Fixture::new();
        let outside = directory();
        std::os::unix::fs::symlink(outside, linked.root.join("linked")).unwrap();
        assert!(
            MountedExchange::open(
                linked.root.join("linked"),
                "drive.json",
                binding(),
                SecretString::from(SECRET)
            )
            .is_err()
        );
    }
}

#[test]
fn stale_config_is_deferred_while_independent_entries_can_be_queued() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[(CONFIG, b"new"), (AUTH, b"SYNTHETIC_FIXTURE_token")]);
    let mut policy = fresh();
    policy.capture_clock_trusted = false;
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        policy,
        RefreshChoices::default(),
    )
    .unwrap();
    assert_eq!(preview.view().disposition, RefreshDisposition::Ready);
    assert_eq!(preview.view().deferred_paths, [CONFIG]);
    assert!(!preview.view().outbox_current);
    let result = publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED).unwrap();
    assert_eq!(result.sequence, Some(2));
    let snapshot = exchange.snapshot().unwrap();
    assert_eq!(snapshot.inbox_manifest().unwrap().entries.len(), 1);
    assert_eq!(snapshot.inbox_manifest().unwrap().entries[0].path, AUTH);
}

#[test]
fn exhausted_sequences_fail_without_publishing() {
    let fixture = Fixture::new();
    fixture.common();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut value = serde_json::to_value(&store.state).unwrap();
    value["inboxIssued"] = MAX_SAFE_SEQUENCE.into();
    store.state = serde_json::from_value::<FlowState>(value).unwrap();
    let mut adapter = FakeAdapter::new(&[(AUTH, b"SYNTHETIC_FIXTURE_token")]);
    let preview = prepare_refresh(
        &exchange,
        &mut store,
        &mut adapter,
        target(),
        fresh(),
        RefreshChoices::default(),
    )
    .unwrap();
    assert!(
        publish_refresh(preview, &exchange, &mut store, &mut adapter, CAPTURED)
            .unwrap_err()
            .contains("exhausted")
    );
    assert_eq!(store.state.inbox_issued(), MAX_SAFE_SEQUENCE);
}
