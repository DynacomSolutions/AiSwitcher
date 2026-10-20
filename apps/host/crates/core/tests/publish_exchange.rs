use ais_host_core::{
    bundle::write_bundle_tar,
    contract::{BundleEntry, BundleKind, BundleManifest, PathClass, sha256_hex},
    create::ModelEntry,
    flow_adapter::SourceSnapshot,
    local_adapter::{decode_response, encode_export_request},
    model::VerifiedModel,
    publish::{
        prepare_first_inbox, publish_first_inbox, publish_model, verify_model_source,
        verify_published,
    },
    release::{hex, sha256},
};
use std::{collections::BTreeMap, fs};

const PASS: &str = "SYNTHETIC_FIXTURE_12";

fn snapshot() -> SourceSnapshot {
    let bytes = b"{\"theme\":\"SYNTHETIC_FIXTURE\"}".to_vec();
    let manifest = BundleManifest {
        version: 1,
        seq: 9,
        created_at: "2026-10-19T00:00:00Z".into(),
        kind: BundleKind::Inbox,
        entries: vec![BundleEntry {
            path: ".claude/settings.json".into(),
            class: PathClass::ConfigSettings,
            sha256: sha256_hex(&bytes),
            size: bytes.len() as u64,
        }],
        last_inbox_seq: None,
        truncated: None,
        skipped_symlinks: None,
    };
    let files = BTreeMap::from([(".claude/settings.json".to_string(), bytes)]);
    SourceSnapshot::from_tar(&write_bundle_tar(&manifest, &files).unwrap()).unwrap()
}

fn directory(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ais-publish-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn model(body: &[u8], dir: &std::path::Path) -> VerifiedModel {
    let path = dir.join("source.bin");
    fs::write(&path, body).unwrap();
    VerifiedModel {
        entry: ModelEntry {
            id: "synthetic".into(),
            name: "Synthetic".into(),
            quality: "fixture".into(),
            size_bytes: body.len() as u64,
            licence_name: "l".into(),
            licence_text: "t".into(),
            repository: "owner/name".into(),
            file: "synthetic.gguf".into(),
            revision: "b".repeat(40),
            sha256: hex(&sha256(body)),
        },
        file: fs::File::open(&path).unwrap(),
        path,
    }
}

#[test]
fn the_first_inbox_is_sequence_one_and_decrypts_with_the_passphrase() {
    let exchange = directory("inbox");
    let path = publish_first_inbox(&exchange, &snapshot(), PASS).unwrap();
    assert_eq!(path, exchange.join("inbox/bundle-1.age"));
    verify_published(&exchange, PASS, None).unwrap();
    assert!(verify_published(&exchange, "SYNTHETIC_FIXTURE_99", None).is_err());
    assert!(
        !exchange.join("models").exists(),
        "no model, no model directory"
    );
    fs::remove_dir_all(&exchange).unwrap();
}

#[test]
fn a_selected_model_is_published_atomically_and_checked_against_its_pin() {
    let exchange = directory("model");
    let scratch = directory("model-src");
    let mut verified = model(b"SYNTHETIC_FIXTURE model bytes", &scratch);
    publish_first_inbox(&exchange, &snapshot(), PASS).unwrap();
    let published = publish_model(&exchange, &mut verified).unwrap();
    assert_eq!(
        fs::read(&published).unwrap(),
        b"SYNTHETIC_FIXTURE model bytes"
    );
    assert!(!exchange.join("models/.synthetic.gguf.tmp").exists());
    verify_published(&exchange, PASS, Some(&verified.entry)).unwrap();

    fs::write(&published, b"SYNTHETIC_FIXTURE model byteX").unwrap();
    assert!(verify_published(&exchange, PASS, Some(&verified.entry)).is_err());
    fs::remove_file(&published).unwrap();
    assert!(verify_published(&exchange, PASS, Some(&verified.entry)).is_err());
    fs::remove_dir_all(&exchange).unwrap();
    fs::remove_dir_all(&scratch).unwrap();
}

#[test]
fn adapter_frames_are_strict() {
    let request = encode_export_request();
    assert_eq!(
        u32::from_be_bytes(request[..4].try_into().unwrap()) as usize,
        request.len() - 4
    );
    let header = br#"{"version":1,"ok":true,"payloadBytes":3}"#;
    let mut good = (header.len() as u32).to_be_bytes().to_vec();
    good.extend_from_slice(header);
    good.extend_from_slice(b"abc");
    assert_eq!(decode_response(&good).unwrap(), b"abc");
    let mut short = good.clone();
    short.pop();
    assert!(decode_response(&short).is_err());
    assert!(decode_response(b"\0\0\0").is_err());
    let failed = br#"{"version":1,"ok":false,"payloadBytes":0}"#;
    let mut bad = (failed.len() as u32).to_be_bytes().to_vec();
    bad.extend_from_slice(failed);
    assert!(decode_response(&bad).is_err());
}

#[test]
fn a_partial_or_completed_first_inbox_is_never_overwritten() {
    let exchange = directory("interrupted");
    let prepared = prepare_first_inbox(&snapshot(), PASS).unwrap();
    fs::create_dir(exchange.join("inbox")).unwrap();
    let temporary = exchange.join("inbox/.bundle-1.age.tmp");
    fs::write(&temporary, b"SYNTHETIC_FIXTURE partial").unwrap();
    assert!(prepared.publish(&exchange).is_err());
    assert!(!exchange.join("inbox/bundle-1.age").exists());
    fs::remove_file(temporary).unwrap();
    let path = prepared.publish(&exchange).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(prepared.publish(&exchange).is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn changed_retained_model_is_rejected_before_publication() {
    let scratch = directory("changed-model");
    let mut verified = model(b"SYNTHETIC_FIXTURE model bytes", &scratch);
    verify_model_source(&mut verified).unwrap();
    fs::write(&verified.path, b"SYNTHETIC_FIXTURE model byteX").unwrap();
    assert!(verify_model_source(&mut verified).is_err());
}
