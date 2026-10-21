use ais_host_core::{
    bundle::{
        bundle_sequence_from_filename, parse_bundle_tar, validate_bundle_filename_sequence,
        write_bundle_tar,
    },
    contract::{BundleEntry, BundleKind, BundleManifest, PathClass, sha256_hex, validate_manifest},
};
use std::collections::BTreeMap;

fn manifest(kind: BundleKind, entries: Vec<BundleEntry>) -> BundleManifest {
    BundleManifest {
        version: 1,
        seq: 3,
        created_at: "2026-10-19T00:00:00Z".into(),
        kind,
        entries,
        last_inbox_seq: Some(2),
        truncated: None,
        skipped_symlinks: None,
    }
}

#[test]
fn emits_and_reads_the_standard_b_tar_root() {
    let bytes = b"{\"theme\":\"SYNTHETIC_FIXTURE\"}".to_vec();
    let entry = BundleEntry {
        path: ".claude/settings.json".into(),
        class: PathClass::ConfigSettings,
        sha256: sha256_hex(&bytes),
        size: bytes.len() as u64,
    };
    let files = BTreeMap::from([(entry.path.clone(), bytes)]);
    let tar = write_bundle_tar(&manifest(BundleKind::Inbox, vec![entry]), &files).unwrap();
    let parsed = parse_bundle_tar(&tar, Some(BundleKind::Inbox)).unwrap();
    assert_eq!(parsed.files, files);
    assert!(tar.starts_with(b"manifest.json"));
}

#[test]
fn accepts_outbox_hash_only_config_entries_but_no_missing_logs() {
    let config = BundleEntry {
        path: ".claude/settings.json".into(),
        class: PathClass::ConfigSettings,
        sha256: "0".repeat(64),
        size: 5,
    };
    validate_manifest(
        &manifest(BundleKind::Outbox, vec![config]),
        &BTreeMap::new(),
    )
    .unwrap();

    let log = BundleEntry {
        path: ".ais/logs/synthetic.jsonl".into(),
        class: PathClass::Logs,
        sha256: "0".repeat(64),
        size: 5,
    };
    assert!(validate_manifest(&manifest(BundleKind::Outbox, vec![log]), &BTreeMap::new()).is_err());
}

#[test]
fn rejects_unsupported_versions_tampering_and_unknown_payloads() {
    let mut value = serde_json::to_value(manifest(BundleKind::Inbox, vec![])).unwrap();
    value["version"] = 2.into();
    assert!(serde_json::from_value::<BundleManifest>(value).is_ok());
    let mut unsupported = manifest(BundleKind::Inbox, vec![]);
    unsupported.version = 2;
    assert!(validate_manifest(&unsupported, &BTreeMap::new()).is_err());
    assert!(
        validate_manifest(
            &manifest(BundleKind::Inbox, vec![]),
            &BTreeMap::from([("extra".into(), vec![1])])
        )
        .is_err()
    );

    let content = b"synthetic";
    let tampered = BundleEntry {
        path: ".claude/settings.json".into(),
        class: PathClass::ConfigSettings,
        sha256: "0".repeat(64),
        size: content.len() as u64,
    };
    assert!(
        validate_manifest(
            &manifest(BundleKind::Inbox, vec![tampered]),
            &BTreeMap::from([(".claude/settings.json".into(), content.to_vec())])
        )
        .is_err()
    );
}

#[test]
fn binds_sequence_to_the_canonical_bundle_filename() {
    let path = std::path::Path::new("bundle-42.age");
    assert_eq!(bundle_sequence_from_filename(path).unwrap(), 42);
    assert!(validate_bundle_filename_sequence(path, 41).is_err());
    validate_bundle_filename_sequence(path, 42).unwrap();
    for name in [
        "bundle-042.age",
        "bundle-+1.age",
        "bundle-1x.age",
        "bundle-0.age",
        "bundle-9007199254740992.age",
        "bundle-1.partial",
    ] {
        assert!(
            bundle_sequence_from_filename(std::path::Path::new(name)).is_err(),
            "{name}"
        );
    }
}

#[test]
fn rejects_case_collisions_and_unknown_classes() {
    let upper = b"synthetic upper".to_vec();
    let lower = b"synthetic lower".to_vec();
    let one = BundleEntry {
        path: ".ais/logs/Session.jsonl".into(),
        class: PathClass::Logs,
        sha256: sha256_hex(&upper),
        size: upper.len() as u64,
    };
    let two = BundleEntry {
        path: ".ais/logs/session.jsonl".into(),
        class: PathClass::Logs,
        sha256: sha256_hex(&lower),
        size: lower.len() as u64,
    };
    let files = BTreeMap::from([(one.path.clone(), upper), (two.path.clone(), lower)]);
    assert!(validate_manifest(&manifest(BundleKind::Inbox, vec![one, two]), &files).is_err());

    let json = br#"{"path":".claude/settings.json","class":"future-class","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":0}"#;
    assert!(serde_json::from_slice::<BundleEntry>(json).is_err());

    let model = BundleEntry {
        path: ".claude/identities/synthetic/plugins/model.gguf".into(),
        class: PathClass::ConfigPlugins,
        sha256: "0".repeat(64),
        size: 0,
    };
    assert!(
        validate_manifest(&manifest(BundleKind::Inbox, vec![model]), &BTreeMap::new()).is_err()
    );
}
