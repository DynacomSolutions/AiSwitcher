use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

pub const MAX_INBOX_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OUTBOX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
pub const MAX_BUNDLE_ENTRIES: usize = 50_000;
pub const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BundleKind {
    Inbox,
    Outbox,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum PathClass {
    #[serde(rename = "auth")]
    Auth,
    #[serde(rename = "logs")]
    Logs,
    #[serde(rename = "config:settings")]
    ConfigSettings,
    #[serde(rename = "config:plugins")]
    ConfigPlugins,
    #[serde(rename = "config:identity")]
    ConfigIdentity,
    #[serde(rename = "ssh")]
    Ssh,
}

impl PathClass {
    pub fn is_config(self) -> bool {
        matches!(
            self,
            Self::ConfigSettings | Self::ConfigPlugins | Self::ConfigIdentity
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleEntry {
    pub path: String,
    pub class: PathClass,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleManifest {
    pub version: u8,
    pub seq: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub kind: BundleKind,
    pub entries: Vec<BundleEntry>,
    #[serde(rename = "lastInboxSeq", skip_serializing_if = "Option::is_none")]
    pub last_inbox_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(rename = "skippedSymlinks", skip_serializing_if = "Option::is_none")]
    pub skipped_symlinks: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bundle {
    pub manifest: BundleManifest,
    pub files: BTreeMap<String, Vec<u8>>,
    pub tar_bytes: Vec<u8>,
}

pub fn safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    path.split('/').all(safe_component)
}

fn safe_component(part: &str) -> bool {
    if part.is_empty()
        || part == "."
        || part == ".."
        || part.ends_with('.')
        || part.ends_with(' ')
        || part
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return false;
    }
    if let Some(number) = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        && matches!(
            number,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        ) {
            return false;
        }
    true
}

/// Classifies paths using the committed JSON exported by B as the source of truth.
pub fn classify_path(path: &str) -> Option<PathClass> {
    if !safe_relative_path(path) {
        return None;
    }
    let leaf = path.rsplit('/').next().unwrap_or(path);
    if [".gguf", ".safetensors", ".onnx", ".pt", ".pth"]
        .iter()
        .any(|suffix| leaf.to_ascii_lowercase().ends_with(suffix))
    {
        return None;
    }
    static RULES: OnceLock<serde_json::Value> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../../src/live/path-classes.json"))
            .expect("B path-class JSON must remain valid")
    });
    let strings = |key: &str| -> Vec<String> {
        rules[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    };
    if strings("protectedPaths").iter().any(|p| p == path) {
        return None;
    }
    let ssh_root = rules["sshRoot"].as_str().unwrap_or(".ssh");
    if path == ssh_root || path.starts_with(&format!("{ssh_root}/")) {
        return Some(PathClass::Ssh);
    }
    if strings("identityRegistryPaths").iter().any(|p| p == path) {
        return Some(PathClass::ConfigIdentity);
    }
    if let Some(class) = rules["configPaths"][path].as_str() {
        return parse_class(class);
    }
    if strings("sharedLogDirectories")
        .iter()
        .any(|d| path.starts_with(&format!("{d}/")))
    {
        return Some(PathClass::Logs);
    }
    if strings("sharedConfigDirectories")
        .iter()
        .any(|d| path.starts_with(&format!("{d}/")))
    {
        return Some(PathClass::ConfigSettings);
    }
    if strings("authPaths").iter().any(|p| p == path) {
        return Some(PathClass::Auth);
    }
    if let Some(class) = rules["rootConfigPaths"][path].as_str() {
        return parse_class(class);
    }

    let roots = strings("toolRoots");
    let (root, relative) = roots.iter().find_map(|root| {
        path.strip_prefix(&format!("{root}/"))
            .map(|relative| (root.as_str(), relative))
    })?;
    let parts: Vec<&str> = relative.split('/').collect();
    let identity_root = parts.first() == Some(&"identities") && parts.len() >= 3;
    let config_parts = if identity_root {
        &parts[2..]
    } else {
        &parts[..]
    };
    let leaf = *parts.last()?;
    if strings("authNames").iter().any(|name| name == leaf) && (identity_root || parts.len() <= 2) {
        return Some(PathClass::Auth);
    }
    if root == ".opencode" && matches!(relative, "data/opencode/auth.json" | "opencode/auth.json") {
        return Some(PathClass::Auth);
    }
    if root == ".kimi-code" && identity_root && relative.ends_with("/credentials/kimi-code.json") {
        return Some(PathClass::Auth);
    }
    if root == ".zai" && leaf == "crush.json" && (identity_root || parts.len() <= 2) {
        return Some(PathClass::Auth);
    }
    if root == ".ali" && leaf == "console-cookie.txt" && (identity_root || parts.len() <= 2) {
        return Some(PathClass::Auth);
    }
    if identity_root && leaf == "identities.json" {
        return Some(PathClass::ConfigIdentity);
    }
    if identity_root
        && strings("identityConfigNames")
            .iter()
            .any(|name| name == leaf)
    {
        return Some(if leaf == "identities.json" {
            PathClass::ConfigIdentity
        } else {
            PathClass::ConfigSettings
        });
    }
    let plugin_dirs = strings("pluginDirectories");
    let relative_plugin = relative
        .split('/')
        .collect::<Vec<_>>()
        .windows(2)
        .any(|w| w[0] == "plugins");
    let configured_plugin = plugin_dirs.iter().any(|d| {
        (identity_root && config_parts.contains(&d.as_str()))
            || relative.starts_with(&format!("{d}/"))
    });
    if (identity_root && relative_plugin) || configured_plugin {
        return Some(PathClass::ConfigPlugins);
    }
    let log_dirs = strings("logDirectories");
    if config_parts
        .iter()
        .any(|part| log_dirs.iter().any(|d| d == part))
        && (identity_root || [".claude", ".codex", ".grok", ".kimi-code", ".pi"].contains(&root))
    {
        return Some(PathClass::Logs);
    }
    if root == ".pi" && relative.starts_with("agent/sessions/") {
        return Some(PathClass::Logs);
    }
    None
}

fn parse_class(value: &str) -> Option<PathClass> {
    match value {
        "auth" => Some(PathClass::Auth),
        "logs" => Some(PathClass::Logs),
        "config:settings" => Some(PathClass::ConfigSettings),
        "config:plugins" => Some(PathClass::ConfigPlugins),
        "config:identity" => Some(PathClass::ConfigIdentity),
        "ssh" => Some(PathClass::Ssh),
        _ => None,
    }
}

pub fn validate_manifest(
    manifest: &BundleManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    if manifest.version != 1 || manifest.seq == 0 || manifest.seq > MAX_SAFE_SEQUENCE {
        return Err("unsupported version or unsafe bundle sequence".into());
    }
    if manifest.created_at.is_empty()
        || chrono::DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
    {
        return Err("invalid bundle timestamp".into());
    }
    if manifest.entries.len() > MAX_BUNDLE_ENTRIES {
        return Err("bundle has too many manifest entries".into());
    }
    if manifest
        .last_inbox_seq
        .is_some_and(|n| n > MAX_SAFE_SEQUENCE)
        || manifest
            .skipped_symlinks
            .is_some_and(|n| n > MAX_SAFE_SEQUENCE)
    {
        return Err("bundle sequence metadata is out of range".into());
    }
    let mut seen = HashSet::new();
    let mut folded = HashSet::new();
    for entry in &manifest.entries {
        if !safe_relative_path(&entry.path) || entry.path == "manifest.json" {
            return Err("unsafe bundle entry path".into());
        }
        if !seen.insert(entry.path.as_str()) || !folded.insert(entry.path.to_lowercase()) {
            return Err("duplicate or case-colliding bundle path".into());
        }
        if classify_path(&entry.path) != Some(entry.class) {
            return Err("bundle entry class does not match B path-class export".into());
        }
        let size_limit = match manifest.kind {
            BundleKind::Inbox => MAX_INBOX_BYTES,
            BundleKind::Outbox => MAX_OUTBOX_BYTES,
        };
        if entry.size > MAX_SAFE_SEQUENCE || entry.size > size_limit as u64 {
            return Err("bundle entry size is out of range".into());
        }
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("invalid bundle entry digest".into());
        }
        let content = files.get(&entry.path);
        let hash_only_config =
            manifest.kind == BundleKind::Outbox && entry.class.is_config() && content.is_none();
        if !hash_only_config {
            let bytes =
                content.ok_or_else(|| format!("bundle payload is missing: {}", entry.path))?;
            if bytes.len() as u64 != entry.size || sha256_hex(bytes) != entry.sha256 {
                return Err(format!(
                    "bundle payload size or digest mismatch: {}",
                    entry.path
                ));
            }
        }
    }
    for path in files.keys() {
        if path != "manifest.json" && !seen.contains(path.as_str()) {
            return Err("bundle contains an unlisted payload".into());
        }
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_classes_follow_the_exported_json() {
        assert_eq!(
            classify_path(".claude/settings.json"),
            Some(PathClass::ConfigSettings)
        );
        assert_eq!(
            classify_path(".codex/identities.json"),
            Some(PathClass::ConfigIdentity)
        );
        assert_eq!(
            classify_path(".ais/logs/example.jsonl"),
            Some(PathClass::Logs)
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/config/.credentials.json"),
            Some(PathClass::Auth)
        );
        assert_eq!(classify_path(".ais/memory/GLOBAL.md"), None);
        assert_eq!(
            classify_path(".claude/projects/plugins/SYNTHETIC_FIXTURE/session.jsonl"),
            Some(PathClass::Logs)
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/plugins/example/index.js"),
            Some(PathClass::ConfigPlugins)
        );
        assert_eq!(
            classify_path(".claude/plugins/example/index.js"),
            Some(PathClass::ConfigPlugins)
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/plugins/model.gguf"),
            None
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/plugins/model.safetensors"),
            None
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/plugins/model.onnx"),
            None
        );
        assert_eq!(
            classify_path(concat!(".claude/identities/synthetic/plugins/model", ".pt")),
            None
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/plugins/model.pth"),
            None
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/foo-plugins/data.json"),
            None
        );
        assert_eq!(
            classify_path(".claude/identities/synthetic/models.json"),
            Some(PathClass::ConfigSettings)
        );
    }

    #[test]
    fn rejects_windows_names_and_case_collisions() {
        for path in [
            "../escape",
            "C:/drive",
            "folder/CON.txt",
            "folder/name.",
            "folder/a:b",
            "folder\\file",
            "folder/COM¹.txt",
            "folder/LPT³",
            "folder/COM²",
            "folder/LPT¹.txt",
        ] {
            assert!(!safe_relative_path(path), "{path}");
        }
        let bytes = b"{}".to_vec();
        let entries = vec![
            BundleEntry {
                path: ".ais/logs/Session.jsonl".into(),
                class: PathClass::Logs,
                sha256: sha256_hex(&bytes),
                size: 2,
            },
            BundleEntry {
                path: ".ais/logs/session.jsonl".into(),
                class: PathClass::Logs,
                sha256: sha256_hex(&bytes),
                size: 2,
            },
        ];
        let manifest = BundleManifest {
            version: 1,
            seq: 1,
            created_at: "2026-10-19T00:00:00Z".into(),
            kind: BundleKind::Inbox,
            entries,
            last_inbox_seq: None,
            truncated: None,
            skipped_symlinks: None,
        };
        assert!(
            validate_manifest(
                &manifest,
                &BTreeMap::from([
                    (".ais/logs/Session.jsonl".into(), bytes.clone()),
                    (".ais/logs/session.jsonl".into(), bytes)
                ])
            )
            .is_err()
        );
    }
}
