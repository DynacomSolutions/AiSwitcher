mod flow_support;
use ais_host_core::conflicts::{ConflictChoice, ConflictReason, analyse, apply_choices};
use flow_support::*;
use std::collections::BTreeMap;

#[test]
fn three_way_changes_are_classified_per_path() {
    let source = [entry(CONFIG, b"new")];
    let drive = [entry(CONFIG, b"old")];
    let source_only = analyse(&source, &drive, &common_hash(), true);
    assert!(source_only.include.contains(CONFIG));
    assert!(source_only.conflicts.is_empty());
    let drive_only = analyse(&drive, &source, &common_hash(), true);
    assert!(drive_only.retain.contains(CONFIG));
    assert!(drive_only.conflicts.is_empty());
    assert!(
        analyse(&source, &source, &common_hash(), true)
            .conflicts
            .is_empty()
    );
    let divergent = analyse(&source, &[entry(CONFIG, b"drive")], &common_hash(), true);
    assert_eq!(divergent.conflicts.len(), 1);
    assert_eq!(divergent.conflicts[0].reason, ConflictReason::Diverged);
}

#[test]
fn unknown_or_stale_state_never_becomes_clean_by_assumption() {
    let source = [entry(CONFIG, b"new")];
    let drive = [entry(CONFIG, b"old")];
    assert_eq!(
        analyse(&source, &drive, &BTreeMap::new(), true).conflicts[0].reason,
        ConflictReason::MissingBaseline
    );
    assert_eq!(
        analyse(&source, &source, &common_hash(), false).conflicts[0].reason,
        ConflictReason::StaleOutbox
    );
    assert_eq!(
        analyse(&source, &[], &common_hash(), true).conflicts[0].reason,
        ConflictReason::MissingBaseline
    );
    assert!(
        analyse(&[], &drive, &common_hash(), true)
            .conflicts
            .is_empty()
    );
    assert!(
        analyse(&[], &drive, &common_hash(), true)
            .include
            .is_empty()
    );
}

#[test]
fn auth_logs_and_ssh_never_prompt_and_all_config_classes_do() {
    let source = [
        entry(AUTH, b"SYNTHETIC_FIXTURE_auth"),
        entry(LOG, b"SYNTHETIC_FIXTURE_log"),
        entry(".ssh/config", b"SYNTHETIC_FIXTURE_ssh"),
    ];
    assert!(
        analyse(&source, &[], &BTreeMap::new(), false)
            .conflicts
            .is_empty()
    );
    let configs = [
        entry(CONFIG, b"settings"),
        entry(".claude/plugins/SYNTHETIC_FIXTURE/plugin.json", b"plugins"),
        entry(".ais/identities.json", b"identities"),
    ];
    assert_eq!(
        analyse(&configs, &[], &BTreeMap::new(), false)
            .conflicts
            .len(),
        3
    );
}

#[test]
fn choices_never_invent_a_conditional_overwrite_token() {
    for choice in [
        ConflictChoice::KeepDrive,
        ConflictChoice::UseSource,
        ConflictChoice::Defer,
    ] {
        let mut analysis = analyse(
            &[entry(CONFIG, b"new")],
            &[entry(CONFIG, b"drive")],
            &common_hash(),
            true,
        );
        apply_choices(&mut analysis, &BTreeMap::from([(CONFIG.into(), choice)])).unwrap();
        assert_eq!(analysis.conflicts[0].choice, choice);
        assert!(!analysis.include.contains(CONFIG));
        assert_eq!(
            analysis.retain.contains(CONFIG),
            choice == ConflictChoice::KeepDrive
        );
    }
    let mut analysis = analyse(&[], &[], &BTreeMap::new(), true);
    assert!(
        apply_choices(
            &mut analysis,
            &BTreeMap::from([(AUTH.into(), ConflictChoice::UseSource)])
        )
        .is_err()
    );
}
