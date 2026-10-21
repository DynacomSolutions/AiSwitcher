mod flow_support;
use ais_host_core::{
    bundle::parse_bundle_tar,
    contract::BundleKind,
    flow_adapter::{HostTarget, ImportSummary},
    logs::{OutboxFreshness, pull_logs},
};
use flow_support::*;
use std::fs;

#[test]
fn imports_only_logs_to_selected_receiver_and_records_idempotent_receipts() {
    let fixture = Fixture::new();
    let path = fixture.write(
        BundleKind::Outbox,
        3,
        2,
        &[
            (CONFIG, b"metadata"),
            (LOG, b"{\"id\":\"SYNTHETIC_FIXTURE_turn\"}\n"),
        ],
        true,
    );
    let before = fs::read(&path).unwrap();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    let mut policy = fresh();
    policy.capture_clock_trusted = false;
    let first = pull_logs(&exchange, &mut store, &mut adapter, &target(), policy).unwrap();
    assert_eq!(first.imported, 1);
    assert_eq!(first.duplicates, 0);
    assert!(first.truncated);
    assert_eq!(first.captured_at, CAPTURED);
    assert_eq!(first.freshness, OutboxFreshness::Unknown);
    let received = parse_bundle_tar(&adapter.imports[0].1, Some(BundleKind::Outbox)).unwrap();
    assert_eq!(received.manifest.entries.len(), 1);
    assert!(received.files.contains_key(LOG));
    assert!(
        !received
            .manifest
            .entries
            .iter()
            .any(|entry| entry.path == CONFIG)
    );
    let again = pull_logs(&exchange, &mut store, &mut adapter, &target(), fresh()).unwrap();
    assert_eq!(again.imported, 0);
    assert_eq!(again.duplicates, 1);
    assert_eq!(adapter.imports.len(), 1);
    let remote = HostTarget::new("SYNTHETIC_FIXTURE_configured_remote").unwrap();
    pull_logs(&exchange, &mut store, &mut adapter, &remote, fresh()).unwrap();
    assert_eq!(adapter.imports.len(), 2);
    assert_eq!(adapter.imports[1].0, remote.handle());
    assert_eq!(store.state.receipt_count(), 2);
    assert_eq!(fs::read(path).unwrap(), before);
    assert_eq!(store.state.inbox_acknowledged(), 0);
}

#[test]
fn failed_remote_import_and_failed_receipt_save_are_retryable() {
    let fixture = Fixture::new();
    let path = fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[(LOG, b"SYNTHETIC_FIXTURE_log\n")],
        false,
    );
    let before = fs::read(&path).unwrap();
    let exchange = fixture.exchange();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    adapter.fail_import = true;
    assert!(pull_logs(&exchange, &mut store, &mut adapter, &target(), fresh()).is_err());
    assert_eq!(store.state.receipt_count(), 0);
    assert_eq!(fs::read(&path).unwrap(), before);
    adapter.fail_import = false;
    store.fail_save = Some(store.saves + 1);
    assert!(pull_logs(&exchange, &mut store, &mut adapter, &target(), fresh()).is_err());
    assert_eq!(store.state.receipt_count(), 0);
    store.fail_save = None;
    pull_logs(&exchange, &mut store, &mut adapter, &target(), fresh()).unwrap();
    assert_eq!(store.state.receipt_count(), 1);
    assert_eq!(adapter.imports.len(), 3);
}

#[test]
fn partial_conflicts_remain_visible_and_never_commit_a_complete_receipt() {
    let fixture = Fixture::new();
    fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[(LOG, b"SYNTHETIC_FIXTURE_log\n")],
        false,
    );
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    adapter.summary = Some(ImportSummary {
        applied: 0,
        skipped: 1,
        conflicts: vec![LOG.into()],
    });
    let result = pull_logs(
        &fixture.exchange(),
        &mut store,
        &mut adapter,
        &target(),
        fresh(),
    )
    .unwrap();
    assert!(!result.complete);
    assert_eq!(result.conflicts, [LOG]);
    assert_eq!(result.duplicates, 0);
    assert_eq!(store.state.receipt_count(), 0);
    adapter.summary = Some(ImportSummary {
        applied: 5,
        skipped: 0,
        conflicts: vec![],
    });
    assert!(
        pull_logs(
            &fixture.exchange(),
            &mut store,
            &mut adapter,
            &target(),
            fresh()
        )
        .is_err()
    );
    assert_eq!(store.state.receipt_count(), 0);
}

#[test]
fn authentication_finishes_before_any_receiver_call() {
    let fixture = Fixture::new();
    let path = fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[(LOG, b"SYNTHETIC_FIXTURE_log\n")],
        false,
    );
    let mut bytes = fs::read(&path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(path, bytes).unwrap();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    assert!(
        pull_logs(
            &fixture.exchange(),
            &mut store,
            &mut adapter,
            &target(),
            fresh()
        )
        .is_err()
    );
    assert!(adapter.imports.is_empty());
    assert_eq!(store.state.receipt_count(), 0);
}

#[test]
fn metadata_only_outbox_does_not_call_the_receiver_or_overwrite_config() {
    let fixture = Fixture::new();
    fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[(CONFIG, b"drive config")],
        false,
    );
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    let mut policy = fresh();
    policy.now_seconds += 600;
    let result = pull_logs(
        &fixture.exchange(),
        &mut store,
        &mut adapter,
        &target(),
        policy,
    )
    .unwrap();
    assert_eq!(result.imported, 0);
    assert!(result.complete);
    assert_eq!(result.freshness, OutboxFreshness::Stale);
    assert!(adapter.imports.is_empty());
}

#[test]
fn damaged_or_missing_inbox_does_not_block_an_authenticated_log_pull() {
    let fixture = Fixture::new();
    fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[(LOG, b"SYNTHETIC_FIXTURE_log\n")],
        false,
    );
    fs::write(
        fixture.root.join("inbox/bundle-1.age"),
        b"SYNTHETIC_FIXTURE_damaged_bundle",
    )
    .unwrap();
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    let result = pull_logs(
        &fixture.exchange(),
        &mut store,
        &mut adapter,
        &target(),
        fresh(),
    )
    .unwrap();
    assert_eq!(result.imported, 1);
    fs::rename(fixture.root.join("inbox"), fixture.root.join("saved-inbox")).unwrap();
    let result = pull_logs(
        &fixture.exchange(),
        &mut store,
        &mut adapter,
        &target(),
        fresh(),
    )
    .unwrap();
    assert_eq!(result.duplicates, 1);
    assert_eq!(adapter.imports.len(), 1);
}

#[test]
fn inconsistent_receiver_counts_and_duplicate_conflicts_never_commit_receipts() {
    let second = ".claude/projects/SYNTHETIC_FIXTURE/second.jsonl";
    let fixture = Fixture::new();
    fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[
            (LOG, b"SYNTHETIC_FIXTURE_log\n"),
            (second, b"SYNTHETIC_FIXTURE_second\n"),
        ],
        false,
    );
    let mut store = MemoryFlowStore::default();
    let mut adapter = FakeAdapter::new(&[]);
    for summary in [
        ImportSummary {
            applied: 2,
            skipped: 1,
            conflicts: vec![LOG.into()],
        },
        ImportSummary {
            applied: 0,
            skipped: 2,
            conflicts: vec![LOG.into(), LOG.into()],
        },
    ] {
        adapter.summary = Some(summary);
        assert!(
            pull_logs(
                &fixture.exchange(),
                &mut store,
                &mut adapter,
                &target(),
                fresh()
            )
            .is_err()
        );
        assert_eq!(store.state.receipt_count(), 0);
    }
}
