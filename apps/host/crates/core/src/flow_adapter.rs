//! Native-only bridge to src/host/remote.ts::requestHost. The application resolves
//! opaque target handles to configured local/SSH targets. SSH policy, timeout,
//! cancellation and additive log merging remain in that existing adapter.

use crate::{
    bundle::parse_bundle_tar,
    contract::{Bundle, BundleKind, sha256_hex},
    registry::validate_handle,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct HostTarget(String);

impl HostTarget {
    pub fn new(native_registry_handle: impl Into<String>) -> Result<Self, String> {
        let value = native_registry_handle.into();
        validate_handle(&value).map_err(|_| "invalid source handle")?;
        Ok(Self(value))
    }
    pub fn handle(&self) -> &str {
        &self.0
    }
}

/// Implement this using requestHost, never a second SSH or log merge engine.
/// Return fixed diagnostics: adapter stderr and credentials must not reach IPC.
pub trait HostAdapter {
    fn export_snapshot(&mut self, target: &HostTarget) -> Result<Vec<u8>, String>;
    fn import_logs(
        &mut self,
        target: &HostTarget,
        log_only_tar: &[u8],
    ) -> Result<ImportSummary, String>;
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportSummary {
    pub applied: u64,
    pub skipped: u64,
    pub conflicts: Vec<String>,
}

/// No Debug or Serialize implementation: this snapshot can contain credentials.
pub struct SourceSnapshot {
    pub(crate) bundle: Bundle,
    digest: String,
}

impl SourceSnapshot {
    pub fn read(adapter: &mut dyn HostAdapter, target: &HostTarget) -> Result<Self, String> {
        let mut tar = adapter
            .export_snapshot(target)
            .map_err(|_| "source snapshot failed")?;
        let result = Self::from_tar(&tar);
        tar.zeroize();
        result
    }

    /// The adapter already canonicalises portable config before exporting.
    pub fn from_tar(tar: &[u8]) -> Result<Self, String> {
        let bundle = parse_bundle_tar(tar, Some(BundleKind::Inbox))?;
        let mut entries = bundle.manifest.entries.clone();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let digest =
            sha256_hex(&serde_json::to_vec(&entries).map_err(|_| "cannot hash source snapshot")?);
        Ok(Self { bundle, digest })
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

impl Drop for SourceSnapshot {
    fn drop(&mut self) {
        self.bundle.tar_bytes.zeroize();
        for bytes in self.bundle.files.values_mut() {
            bytes.zeroize();
        }
    }
}

/// Temporary payload copies are cleared on every early-return path as well as
/// on success. Only metadata is retained in previews and flow journals.
pub(crate) struct PayloadFiles(pub std::collections::BTreeMap<String, Vec<u8>>);

impl Drop for PayloadFiles {
    fn drop(&mut self) {
        for bytes in self.0.values_mut() {
            bytes.zeroize();
        }
    }
}
