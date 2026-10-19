//! Authenticate locally, then send a log-only tar through the existing adapter.
//! Neither metadata-only config entries nor refreshed auth are host writes.

use crate::{
    bundle::write_bundle_tar,
    contract::{PathClass, sha256_hex},
    exchange::MountedExchange,
    flow_adapter::{HostAdapter, HostTarget, PayloadFiles},
    flow_state::FlowStore,
    refresh::FreshnessPolicy,
};
use serde::Serialize;
use zeroize::Zeroize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutboxFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullLogsResult {
    pub imported: u64,
    pub duplicates: u64,
    pub truncated: bool,
    pub captured_at: String,
    pub freshness: OutboxFreshness,
    pub conflicts: Vec<String>,
    pub complete: bool,
}

pub fn pull_logs(
    exchange: &MountedExchange,
    store: &mut dyn FlowStore,
    adapter: &mut dyn HostAdapter,
    destination: &HostTarget,
    freshness: FreshnessPolicy,
) -> Result<PullLogsResult, String> {
    let outbox = exchange
        .read_outbox()?
        .ok_or("no completed outbox is available")?;
    let mut state = store.load(exchange.binding())?;
    state.validate(exchange.binding())?;
    let receipt = sha256_hex(
        &serde_json::to_vec(&(exchange.binding(), destination, &outbox.digest))
            .map_err(|_| "cannot identify log import")?,
    );
    let mut manifest = outbox.bundle.manifest.clone();
    manifest
        .entries
        .retain(|entry| entry.class == PathClass::Logs);
    let count = manifest.entries.len() as u64;
    let mut result = PullLogsResult {
        imported: 0,
        duplicates: 0,
        truncated: manifest.truncated.unwrap_or(false),
        captured_at: manifest.created_at.clone(),
        freshness: if !freshness.capture_clock_trusted {
            OutboxFreshness::Unknown
        } else if freshness.is_current(&manifest) {
            OutboxFreshness::Current
        } else {
            OutboxFreshness::Stale
        },
        conflicts: Vec::new(),
        complete: true,
    };
    if state.log_receipts.contains(&receipt) {
        result.duplicates = count;
        return Ok(result);
    }
    if state.log_receipts.len() >= 1024 {
        return Err("log receipt storage is full; review retained import records".into());
    }
    let files = PayloadFiles(
        manifest
            .entries
            .iter()
            .map(|entry| {
                outbox
                    .bundle
                    .files
                    .get(&entry.path)
                    .cloned()
                    .map(|bytes| (entry.path.clone(), bytes))
                    .ok_or("outbox log payload is missing")
            })
            .collect::<Result<_, _>>()?,
    );
    let mut tar = write_bundle_tar(&manifest, &files.0)?;
    drop(files);
    // A connection failure or cancellation may follow partial additive import.
    // Do not commit a receipt; retry through the same idempotent merge adapter.
    let import = if count == 0 {
        Ok(crate::flow_adapter::ImportSummary::default())
    } else {
        adapter
            .import_logs(destination, &tar)
            .map_err(|_| "log import failed; retry on the selected receiver")
    };
    tar.zeroize();
    let imported = import?;
    if imported.applied > count
        || imported.skipped > count.saturating_sub(imported.applied)
        || imported.conflicts.len() as u64 != imported.skipped
        || imported
            .conflicts
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != imported.conflicts.len()
        || imported
            .conflicts
            .iter()
            .any(|path| !manifest.entries.iter().any(|entry| &entry.path == path))
    {
        return Err("log receiver returned an invalid import result".into());
    }
    result.imported = imported.applied;
    result.duplicates = count
        .saturating_sub(imported.applied)
        .saturating_sub(imported.skipped);
    result.conflicts = imported.conflicts;
    result.complete = result.conflicts.is_empty();
    if result.complete {
        state.log_receipts.insert(receipt);
        store.save(&state)?;
    }
    // No outbox deletion, acknowledgement or write is performed here.
    Ok(result)
}
