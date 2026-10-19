mod escrow_support;
mod flow_support;
mod removal_support;

use ais_host_core::{
    escrow::{EscrowPolicy, EscrowService, RetentionClock},
    flow_state::DriveBinding,
    remove::{
        ConfirmedRemoval, RemoveOptions, ResumeRemoval, acknowledge_removal_failures,
        execute_removal, forget_drive_record, prepare_removal, resume_removal_review,
    },
    revocation::RevocationEffect,
};
use flow_support::{MemoryFlowStore, binding};
use removal_support::*;
use std::collections::BTreeSet;

fn confirm(options: RemoveOptions, backend: &mut FakeRemoval) -> ConfirmedRemoval {
    let review = prepare_removal(binding(), options, backend, 100).unwrap();
    let digest = review.view().digest.clone();
    let consent = if options.revoke_credentials {
        BTreeSet::from([IDENTITY.into(), SHARED.into()])
    } else {
        BTreeSet::new()
    };
    review.confirm(&digest, consent, 101).unwrap()
}

#[test]
fn all_sixteen_selections_only_attempt_selected_steps_and_completed_steps_are_not_repeated() {
    assert_eq!(
        RemoveOptions::default(),
        RemoveOptions {
            pull_logs: false,
            erase_storage: false,
            revoke_credentials: false,
            forget_drive: false
        }
    );
    for bits in 0_u8..16 {
        let options = RemoveOptions {
            pull_logs: bits & 1 != 0,
            erase_storage: bits & 2 != 0,
            revoke_credentials: bits & 4 != 0,
            forget_drive: bits & 8 != 0,
        };
        let mut backend = FakeRemoval::default();
        let confirmed = confirm(options, &mut backend);
        let mut store = MemoryFlowStore::default();
        let result = execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval::default(),
        )
        .unwrap();
        assert_eq!(result.pull_logs.completed(), options.pull_logs);
        assert_eq!(result.erase_storage.failed(), options.erase_storage);
        assert!(!result.erase_storage.completed());
        assert_eq!(
            result.revoke_credentials.completed(),
            options.revoke_credentials
        );
        assert_eq!(result.forget_drive.completed(), options.forget_drive);
        assert_eq!(backend.pulls, usize::from(options.pull_logs));
        assert_eq!(backend.forgets, usize::from(options.forget_drive));
        assert_eq!(
            backend.revokes.len(),
            usize::from(options.revoke_credentials)
        );
        assert_eq!(backend.inventories > 0, options.revoke_credentials);
        let again = execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval::default(),
        )
        .unwrap();
        assert_eq!(result, again);
        assert_eq!(backend.pulls, usize::from(options.pull_logs));
        assert_eq!(backend.forgets, usize::from(options.forget_drive));
        assert_eq!(
            backend.revokes.len(),
            usize::from(options.revoke_credentials)
        );
    }
}

#[test]
fn failed_logs_pause_other_steps_until_explicit_continuation_and_failures_remain_visible() {
    let mut backend = FakeRemoval {
        fail_logs: true,
        ..Default::default()
    };
    let options = RemoveOptions {
        pull_logs: true,
        erase_storage: true,
        revoke_credentials: true,
        forget_drive: true,
    };
    let confirmed = confirm(options, &mut backend);
    let mut store = MemoryFlowStore::default();
    let first = execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval::default(),
    )
    .unwrap();
    assert!(first.paused_for_logs && first.pull_logs.failed());
    assert!(!first.erase_storage.failed());
    assert!(backend.revokes.is_empty());
    assert_eq!(backend.forgets, 0);
    execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval::default(),
    )
    .unwrap();
    assert_eq!(backend.pulls, 1);
    let review = resume_removal_review(&mut store, &binding(), 200).unwrap();
    let digest = review.view().digest.clone();
    let resumed = review
        .confirm(
            &digest,
            BTreeSet::from([IDENTITY.into(), SHARED.into()]),
            201,
        )
        .unwrap();
    let result = execute_removal(
        &resumed,
        &mut store,
        &mut backend,
        ResumeRemoval {
            continue_without_logs: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!result.paused_for_logs);
    assert!(result.pull_logs.failed());
    assert!(result.erase_storage.failed());
    assert!(result.forget_drive.completed());
    assert_eq!(backend.revokes.len(), 1);
    assert!(!store.state.removal().unwrap().failures_seen());
    let next = confirm(RemoveOptions::default(), &mut backend);
    assert!(execute_removal(&next, &mut store, &mut backend, ResumeRemoval::default()).is_err());
    assert!(
        acknowledge_removal_failures(&mut store, &binding(), "SYNTHETIC_FIXTURE_wrong_review")
            .is_err()
    );
    acknowledge_removal_failures(&mut store, &binding(), &digest).unwrap();
    execute_removal(&next, &mut store, &mut backend, ResumeRemoval::default()).unwrap();
}

#[test]
fn retrying_logs_is_explicit_and_continuation_cannot_be_preapproved() {
    let mut backend = FakeRemoval {
        incomplete_logs: true,
        ..Default::default()
    };
    let confirmed = confirm(
        RemoveOptions {
            pull_logs: true,
            forget_drive: true,
            ..Default::default()
        },
        &mut backend,
    );
    let mut store = MemoryFlowStore::default();
    assert!(
        execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval {
                continue_without_logs: true,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert_eq!(backend.pulls, 0);
    assert!(
        execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval::default()
        )
        .unwrap()
        .paused_for_logs
    );
    backend.incomplete_logs = false;
    let result = execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval {
            retry_failed_logs: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(result.pull_logs.completed());
    assert!(result.forget_drive.completed());
    assert_eq!(backend.pulls, 2);
    assert_eq!(backend.forgets, 1);
    assert!(
        execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval {
                retry_failed_logs: true,
                continue_without_logs: true
            }
        )
        .is_err()
    );
}

#[test]
fn partial_provider_failure_does_not_prevent_independent_forgetting_and_can_be_retried() {
    let mut backend = FakeRemoval {
        fail_revoke: true,
        ..Default::default()
    };
    let confirmed = confirm(
        RemoveOptions {
            revoke_credentials: true,
            forget_drive: true,
            ..Default::default()
        },
        &mut backend,
    );
    let mut store = MemoryFlowStore::default();
    let result = execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval::default(),
    )
    .unwrap();
    assert!(result.revoke_credentials.failed());
    assert!(result.forget_drive.completed());
    assert_eq!(result.providers[0].effect, RevocationEffect::Failed);
    assert!(
        result.providers[0]
            .next_action
            .as_ref()
            .unwrap()
            .contains("retry")
    );
    backend.fail_revoke = false;
    let result = execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval::default(),
    )
    .unwrap();
    assert!(result.revoke_credentials.completed());
    assert_eq!(backend.forgets, 1);
}

#[test]
fn review_is_exact_short_lived_and_cannot_add_unreviewed_identity_consent() {
    for (digest_matches, time, extra_consent) in [
        (false, 101, false),
        (true, 190, false),
        (true, 99, false),
        (true, 101, true),
    ] {
        let mut backend = FakeRemoval::default();
        let review =
            prepare_removal(binding(), RemoveOptions::default(), &mut backend, 100).unwrap();
        let digest = if digest_matches {
            review.view().digest.clone()
        } else {
            "SYNTHETIC_FIXTURE_wrong_review".into()
        };
        let consent = if extra_consent {
            BTreeSet::from([IDENTITY.into()])
        } else {
            BTreeSet::new()
        };
        assert!(review.confirm(&digest, consent, time).is_err());
        assert_eq!(backend.forgets, 0);
        assert!(backend.revokes.is_empty());
    }
}

#[test]
fn journal_save_failure_prevents_operations_and_generation_mismatch_refuses_resume() {
    let mut backend = FakeRemoval::default();
    let confirmed = confirm(
        RemoveOptions {
            forget_drive: true,
            ..Default::default()
        },
        &mut backend,
    );
    let mut store = MemoryFlowStore {
        fail_save: Some(1),
        ..Default::default()
    };
    assert!(
        execute_removal(
            &confirmed,
            &mut store,
            &mut backend,
            ResumeRemoval::default()
        )
        .is_err()
    );
    assert_eq!(backend.forgets, 0);
    store.fail_save = None;
    execute_removal(
        &confirmed,
        &mut store,
        &mut backend,
        ResumeRemoval::default(),
    )
    .unwrap();
    assert!(
        resume_removal_review(
            &mut store,
            &DriveBinding::new(flow_support::DRIVE, 2).unwrap(),
            200
        )
        .is_err()
    );
}

#[test]
fn forgetting_deletes_only_matching_drive_escrow_and_retries_a_locked_store() {
    use escrow_support::{FakeClock, FakeStore, MemoryRegistry, secret};
    let mut backend = FakeStore::default();
    let mut registry = MemoryRegistry::default();
    let clock = RetentionClock::new(FakeClock::new(100));
    EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(
            flow_support::DRIVE,
            EscrowPolicy::Until(200),
            vec![],
            Some(&secret()),
        )
        .unwrap();
    EscrowService::new(&mut backend, &mut registry, &clock)
        .create_drive(
            "SYNTHETIC_FIXTURE_other_drive",
            EscrowPolicy::Until(200),
            vec![],
            Some(&secret()),
        )
        .unwrap();
    let wrong = DriveBinding::new(flow_support::DRIVE, 2).unwrap();
    assert!(forget_drive_record(&mut backend, &mut registry, &clock, &wrong).is_err());
    assert_eq!(backend.deletes, 0);
    backend.locked = true;
    assert!(forget_drive_record(&mut backend, &mut registry, &clock, &binding()).is_err());
    assert!(registry.data.record(flow_support::DRIVE).is_some());
    assert_eq!(backend.values.len(), 2);
    backend.locked = false;
    forget_drive_record(&mut backend, &mut registry, &clock, &binding()).unwrap();
    assert!(registry.data.record(flow_support::DRIVE).is_none());
    assert!(
        registry
            .data
            .record("SYNTHETIC_FIXTURE_other_drive")
            .is_some()
    );
    assert_eq!(backend.values.len(), 1);
    let deletes = backend.deletes;
    forget_drive_record(&mut backend, &mut registry, &clock, &binding()).unwrap();
    assert_eq!(backend.deletes, deletes);
    assert_eq!(backend.gets, 0);
}

#[test]
fn removal_journal_updates_preserve_the_log_import_receipt() {
    use ais_host_core::{
        contract::BundleKind,
        exchange::MountedExchange,
        flow_state::FlowStore,
        logs::{PullLogsResult, pull_logs},
        remove::RemovalBackend,
        revocation::{CredentialScope, RevocationBackend},
    };
    use flow_support::{FakeAdapter, Fixture, LOG, fresh, target};

    struct Backend {
        exchange: MountedExchange,
        adapter: FakeAdapter,
        forgets: usize,
    }
    impl RevocationBackend for Backend {
        fn inventory(&mut self, _: &DriveBinding) -> Result<Vec<CredentialScope>, String> {
            panic!("revocation was not selected");
        }
        fn revoke(&mut self, _: &CredentialScope) -> Result<(), String> {
            panic!("revocation was not selected");
        }
    }
    impl RemovalBackend for Backend {
        fn pull_logs(
            &mut self,
            _: &DriveBinding,
            store: &mut dyn FlowStore,
        ) -> Result<PullLogsResult, String> {
            pull_logs(&self.exchange, store, &mut self.adapter, &target(), fresh())
        }
        fn forget_drive(&mut self, _: &DriveBinding) -> Result<(), String> {
            self.forgets += 1;
            Ok(())
        }
    }
    let fixture = Fixture::new();
    fixture.write(
        BundleKind::Outbox,
        1,
        0,
        &[(LOG, b"SYNTHETIC_FIXTURE_log\n")],
        false,
    );
    let mut backend = Backend {
        exchange: fixture.exchange(),
        adapter: FakeAdapter::new(&[]),
        forgets: 0,
    };
    let review = prepare_removal(
        binding(),
        RemoveOptions {
            pull_logs: true,
            forget_drive: true,
            ..Default::default()
        },
        &mut backend,
        100,
    )
    .unwrap();
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
    assert!(result.pull_logs.completed() && result.forget_drive.completed());
    assert_eq!(store.state.receipt_count(), 1);
    assert_eq!(backend.forgets, 1);
    let repeated = backend.pull_logs(&binding(), &mut store).unwrap();
    assert_eq!(repeated.duplicates, 1);
    assert_eq!(backend.adapter.imports.len(), 1);
}
