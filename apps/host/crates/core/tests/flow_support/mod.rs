#![allow(dead_code)]
use ais_host_core::{
    bundle::{parse_bundle_tar, write_bundle_tar},
    contract::{BundleEntry, BundleKind, BundleManifest, classify_path, sha256_hex},
    escrow::SecretString,
    exchange::MountedExchange,
    flow_adapter::{HostAdapter, HostTarget, ImportSummary},
    flow_state::{DriveBinding, FlowState, FlowStore},
    refresh::FreshnessPolicy,
};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

pub const DRIVE: &str = "SYNTHETIC_FIXTURE_drive";
pub const SECRET: &str = "SYNTHETIC_FIXTURE exchange passphrase";
pub const CONFIG: &str = ".claude/settings.json";
pub const LOG: &str = ".claude/projects/SYNTHETIC_FIXTURE/session.jsonl";
pub const AUTH: &str = ".claude/.credentials.json";
pub const CAPTURED: &str = "2026-10-19T04:00:00Z";

pub fn binding() -> DriveBinding {
    DriveBinding::new(DRIVE, 1).unwrap()
}
pub fn target() -> HostTarget {
    HostTarget::new("SYNTHETIC_FIXTURE_local").unwrap()
}
pub fn fresh() -> FreshnessPolicy {
    FreshnessPolicy {
        now_seconds: chrono::DateTime::parse_from_rfc3339(CAPTURED)
            .unwrap()
            .timestamp(),
        maximum_age_seconds: 300,
        capture_clock_trusted: true,
    }
}
pub fn entry(path: &str, content: &[u8]) -> BundleEntry {
    BundleEntry {
        path: path.into(),
        class: classify_path(path).expect("classified fixture"),
        sha256: sha256_hex(content),
        size: content.len() as u64,
    }
}
pub fn tar(
    kind: BundleKind,
    seq: u64,
    acknowledged: u64,
    entries: &[(&str, &[u8])],
    truncated: bool,
) -> Vec<u8> {
    let manifest = BundleManifest {
        version: 1,
        seq,
        created_at: CAPTURED.into(),
        kind,
        entries: entries
            .iter()
            .map(|(path, bytes)| entry(path, bytes))
            .collect(),
        last_inbox_seq: (kind == BundleKind::Outbox).then_some(acknowledged),
        truncated: (kind == BundleKind::Outbox).then_some(truncated),
        skipped_symlinks: (kind == BundleKind::Outbox).then_some(0),
    };
    let files = entries
        .iter()
        .filter(|(path, _)| kind != BundleKind::Outbox || !classify_path(path).unwrap().is_config())
        .map(|(path, bytes)| (path.to_string(), bytes.to_vec()))
        .collect();
    write_bundle_tar(&manifest, &files).unwrap()
}

/// Low-cost age is used only for synthetic input fixtures. Production inbox
/// publication is exercised separately and still uses age's default cost.
pub fn encrypted(tar: &[u8]) -> Vec<u8> {
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(SECRET));
    recipient.set_work_factor(1);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .unwrap();
    let mut bytes = Vec::new();
    let mut writer = encryptor.wrap_output(&mut bytes).unwrap();
    writer.write_all(tar).unwrap();
    writer.finish().unwrap();
    bytes
}

pub fn directory() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let path = std::env::temp_dir().join(format!(
        "ais-flow-SYNTHETIC_FIXTURE-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}
pub struct Fixture {
    pub root: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let root = directory();
        fs::create_dir(root.join("inbox")).unwrap();
        fs::create_dir(root.join("outbox")).unwrap();
        fs::write(
            root.join("drive.json"),
            serde_json::to_vec(&serde_json::json!({"driveId": DRIVE})).unwrap(),
        )
        .unwrap();
        Self { root }
    }
    pub fn write(
        &self,
        kind: BundleKind,
        seq: u64,
        ack: u64,
        entries: &[(&str, &[u8])],
        truncated: bool,
    ) -> PathBuf {
        let path = self
            .root
            .join(if kind == BundleKind::Inbox {
                "inbox"
            } else {
                "outbox"
            })
            .join(format!("bundle-{seq}.age"));
        fs::write(&path, encrypted(&tar(kind, seq, ack, entries, truncated))).unwrap();
        path
    }
    pub fn exchange(&self) -> MountedExchange {
        MountedExchange::open(
            self.root.clone(),
            "drive.json",
            binding(),
            SecretString::from(SECRET),
        )
        .unwrap()
    }
    pub fn common(&self) {
        self.write(BundleKind::Inbox, 1, 0, &[(CONFIG, b"old")], false);
        self.write(BundleKind::Outbox, 1, 1, &[(CONFIG, b"old")], false);
    }
}

pub struct MemoryFlowStore {
    pub state: FlowState,
    pub saves: usize,
    pub fail_save: Option<usize>,
}
impl Default for MemoryFlowStore {
    fn default() -> Self {
        Self {
            state: FlowState::new(binding()),
            saves: 0,
            fail_save: None,
        }
    }
}
impl FlowStore for MemoryFlowStore {
    fn load(&mut self, drive: &DriveBinding) -> Result<FlowState, String> {
        self.state.validate(drive)?;
        // Round trip the durable representation, as after reopening the app.
        serde_json::from_slice(&serde_json::to_vec(&self.state).unwrap())
            .map_err(|_| "invalid fixture state".into())
    }
    fn save(&mut self, state: &FlowState) -> Result<(), String> {
        state.validate(state.binding())?;
        self.saves += 1;
        if self.fail_save == Some(self.saves) {
            return Err("SYNTHETIC_FIXTURE interrupted persistence".into());
        }
        self.state = state.clone();
        Ok(())
    }
}

pub struct FakeAdapter {
    pub source: Vec<u8>,
    pub exports: usize,
    pub imports: Vec<(String, Vec<u8>)>,
    pub fail_export: bool,
    pub fail_import: bool,
    pub summary: Option<ImportSummary>,
}
impl FakeAdapter {
    pub fn new(entries: &[(&str, &[u8])]) -> Self {
        Self {
            source: tar(BundleKind::Inbox, 1, 0, entries, false),
            exports: 0,
            imports: Vec::new(),
            fail_export: false,
            fail_import: false,
            summary: None,
        }
    }
}
impl HostAdapter for FakeAdapter {
    fn export_snapshot(&mut self, _: &HostTarget) -> Result<Vec<u8>, String> {
        self.exports += 1;
        if self.fail_export {
            Err("SYNTHETIC_FIXTURE source unavailable".into())
        } else {
            Ok(self.source.clone())
        }
    }
    fn import_logs(&mut self, target: &HostTarget, bytes: &[u8]) -> Result<ImportSummary, String> {
        self.imports.push((target.handle().into(), bytes.to_vec()));
        if self.fail_import {
            return Err("SYNTHETIC_FIXTURE connection lost".into());
        }
        let bundle = parse_bundle_tar(bytes, Some(BundleKind::Outbox))?;
        assert!(
            bundle
                .manifest
                .entries
                .iter()
                .all(|e| e.class == ais_host_core::contract::PathClass::Logs)
        );
        Ok(self.summary.clone().unwrap_or(ImportSummary {
            applied: bundle.files.len() as u64,
            skipped: 0,
            conflicts: Vec::new(),
        }))
    }
}

pub fn common_hash() -> BTreeMap<String, String> {
    BTreeMap::from([(CONFIG.into(), sha256_hex(b"old"))])
}
