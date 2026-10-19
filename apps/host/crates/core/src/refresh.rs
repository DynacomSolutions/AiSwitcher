use crate::{
    conflicts::{self, Conflict, ConflictChoice},
    contract::{BundleKind, BundleManifest, MAX_SAFE_SEQUENCE, sha256_hex},
    exchange::{ExchangeSnapshot, MountedExchange},
    flow_adapter::{HostAdapter, HostTarget, PayloadFiles, SourceSnapshot},
    flow_state::{FlowState, FlowStore, OutboxSeen, PendingRefresh},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Native clock assessment, never an assertion supplied by the webview. If the
/// capture clock cannot be established as accurate, keep freshness unknown.
#[derive(Clone, Copy, Debug)]
pub struct FreshnessPolicy {
    pub now_seconds: i64,
    pub maximum_age_seconds: u64,
    pub capture_clock_trusted: bool,
}

impl FreshnessPolicy {
    pub fn is_current(&self, manifest: &BundleManifest) -> bool {
        if !self.capture_clock_trusted {
            return false;
        }
        let Ok(captured) = chrono::DateTime::parse_from_rfc3339(&manifest.created_at) else {
            return false;
        };
        self.now_seconds
            .checked_sub(captured.timestamp())
            .is_some_and(|age| age >= 0 && age as u64 <= self.maximum_age_seconds)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefreshDisposition {
    Ready,
    ReusePending,
    AwaitingAcknowledgement,
    NoSafeEntries,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPreview {
    pub acknowledged_seq: u64,
    pub pending_seq: Option<u64>,
    pub outbox_created_at: Option<String>,
    pub conflicts: Vec<Conflict>,
    pub source_digest: String,
    pub disposition: RefreshDisposition,
    pub replaces_pending: bool,
    pub deferred_paths: Vec<String>,
    pub outbox_current: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshChoices {
    #[serde(default)]
    pub configuration: BTreeMap<String, ConflictChoice>,
    #[serde(default)]
    pub replace_pending: bool,
}

/// Retain natively under an opaque preview id. It contains hashes and choices,
/// never credential bytes, and cannot be reconstructed from IPC JSON.
pub struct PreparedRefresh {
    view: RefreshPreview,
    source: HostTarget,
    binding: crate::flow_state::DriveBinding,
    exchange_fingerprint: String,
    state_digest: String,
    included: BTreeSet<String>,
    selection_digest: String,
}

impl PreparedRefresh {
    pub fn view(&self) -> &RefreshPreview {
        &self.view
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub sequence: Option<u64>,
    pub acknowledged: bool,
    pub reused_pending: bool,
    pub deferred_paths: Vec<String>,
}

pub fn prepare_refresh(
    exchange: &MountedExchange,
    store: &mut dyn FlowStore,
    adapter: &mut dyn HostAdapter,
    source: HostTarget,
    freshness: FreshnessPolicy,
    choices: RefreshChoices,
) -> Result<PreparedRefresh, String> {
    let snapshot = exchange.snapshot()?;
    let mut state = store.load(exchange.binding())?;
    state.validate(exchange.binding())?;
    reconcile(&mut state, &snapshot)?;
    store.save(&state)?;
    let source_snapshot = SourceSnapshot::read(adapter, &source)?;
    let outbox = snapshot.outbox_manifest();
    let current = outbox.is_some_and(|manifest| {
        manifest.seq >= state.outbox_issued
            && manifest
                .last_inbox_seq
                .is_some_and(|seq| seq >= state.inbox_acknowledged)
            && freshness.is_current(manifest)
    });
    let mut analysis = conflicts::analyse(
        &source_snapshot.bundle.manifest.entries,
        outbox
            .map(|manifest| manifest.entries.as_slice())
            .unwrap_or_default(),
        &state.common_hashes,
        current,
    );
    conflicts::apply_choices(&mut analysis, &choices.configuration)?;
    let included: BTreeSet<_> = source_snapshot
        .bundle
        .manifest
        .entries
        .iter()
        .filter(|entry| !entry.class.is_config() || analysis.include.contains(&entry.path))
        .map(|entry| entry.path.clone())
        .collect();
    let selection_digest = selection_digest(&source_snapshot, &included)?;
    let pending_seq = snapshot
        .inbox_manifest()
        .map(|m| m.seq)
        .filter(|seq| *seq > state.inbox_acknowledged);
    let identical_pending = state.pending.as_ref().is_some_and(|pending| {
        pending_seq == Some(pending.sequence)
            && pending.source_digest == source_snapshot.digest()
            && pending.selection_digest == selection_digest
    });
    let disposition = if identical_pending {
        RefreshDisposition::ReusePending
    } else if pending_seq.is_some() && !choices.replace_pending {
        RefreshDisposition::AwaitingAcknowledgement
    } else if included.is_empty() {
        RefreshDisposition::NoSafeEntries
    } else {
        RefreshDisposition::Ready
    };
    let view = RefreshPreview {
        acknowledged_seq: state.inbox_acknowledged,
        pending_seq,
        outbox_created_at: outbox.map(|m| m.created_at.clone()),
        deferred_paths: analysis
            .conflicts
            .iter()
            .filter(|c| c.choice != ConflictChoice::KeepDrive)
            .map(|c| c.path.clone())
            .collect(),
        conflicts: analysis.conflicts,
        source_digest: source_snapshot.digest().to_owned(),
        disposition,
        replaces_pending: pending_seq.is_some() && choices.replace_pending && !identical_pending,
        outbox_current: current,
    };
    Ok(PreparedRefresh {
        view,
        source,
        binding: exchange.binding().clone(),
        exchange_fingerprint: snapshot.fingerprint().to_owned(),
        state_digest: state_digest(&state)?,
        included,
        selection_digest,
    })
}

pub fn publish_refresh(
    prepared: PreparedRefresh,
    exchange: &MountedExchange,
    store: &mut dyn FlowStore,
    adapter: &mut dyn HostAdapter,
    created_at: &str,
) -> Result<RefreshResult, String> {
    if &prepared.binding != exchange.binding() {
        return Err("refresh belongs to another drive generation".into());
    }
    // Store implementations hold their own lock for the entire operation.
    let operation_lock = exchange.lock()?;
    let mut state = store.load(exchange.binding())?;
    state.validate(exchange.binding())?;
    if state_digest(&state)? != prepared.state_digest {
        return Err("drive state changed; review a new preview".into());
    }
    let source = SourceSnapshot::read(adapter, &prepared.source)?;
    if source.digest() != prepared.view.source_digest {
        return Err("source changed; review a new preview".into());
    }
    let snapshot = exchange.snapshot()?;
    if snapshot.fingerprint() != prepared.exchange_fingerprint {
        return Err("exchange changed; review a new preview".into());
    }
    let result = |sequence, reused_pending| RefreshResult {
        sequence,
        acknowledged: false,
        reused_pending,
        deferred_paths: prepared.view.deferred_paths.clone(),
    };
    match prepared.view.disposition {
        RefreshDisposition::AwaitingAcknowledgement => return Err(
            "a different refresh is pending; wait for acknowledgement or review its replacement"
                .into(),
        ),
        RefreshDisposition::ReusePending => return Ok(result(prepared.view.pending_seq, true)),
        RefreshDisposition::NoSafeEntries => return Ok(result(None, false)),
        RefreshDisposition::Ready => {}
    }
    let sequence = state
        .inbox_issued
        .max(state.inbox_acknowledged)
        .max(snapshot.inbox_manifest().map(|m| m.seq).unwrap_or(0))
        .checked_add(1)
        .filter(|n| *n <= MAX_SAFE_SEQUENCE)
        .ok_or("inbox sequence space is exhausted")?;
    let entries: Vec<_> = source
        .bundle
        .manifest
        .entries
        .iter()
        .filter(|entry| prepared.included.contains(&entry.path))
        .cloned()
        .collect();
    let manifest = BundleManifest {
        version: 1,
        seq: sequence,
        created_at: created_at.into(),
        kind: BundleKind::Inbox,
        entries,
        last_inbox_seq: None,
        truncated: None,
        skipped_symlinks: None,
    };
    let files = PayloadFiles(
        source
            .bundle
            .files
            .iter()
            .filter(|(path, _)| prepared.included.contains(*path))
            .map(|(path, bytes)| (path.clone(), bytes.clone()))
            .collect(),
    );
    // Validate timestamp, sizes and payloads before consuming a reservation.
    crate::contract::validate_manifest(&manifest, &files.0)?;
    state.inbox_issued = sequence;
    state.pending = Some(PendingRefresh {
        sequence,
        source_digest: source.digest().into(),
        selection_digest: prepared.selection_digest,
        proposed_hashes: manifest
            .entries
            .iter()
            .filter(|entry| entry.class.is_config())
            .map(|entry| (entry.path.clone(), entry.sha256.clone()))
            .collect(),
    });
    store.save(&state)?; // Durable high water first. Failure must never publish.
    exchange.publish(&operation_lock, &snapshot, &manifest, &files.0)?;
    Ok(result(Some(sequence), false))
}

/// Another computer may adopt counters from authenticated exchange metadata,
/// but cannot fabricate a common configuration baseline from an acknowledgement.
pub fn adopt_authenticated_exchange(snapshot: &ExchangeSnapshot) -> Result<FlowState, String> {
    if snapshot.inbox_manifest().is_none() && snapshot.outbox_manifest().is_none() {
        return Err("authenticated exchange state is missing; refusing ambiguous recovery".into());
    }
    let mut state = FlowState::new(snapshot.binding().clone());
    reconcile(&mut state, snapshot)?;
    Ok(state)
}

pub fn reconcile(state: &mut FlowState, snapshot: &ExchangeSnapshot) -> Result<(), String> {
    state.validate(snapshot.binding())?;
    if let Some(inbox) = snapshot.inbox_manifest() {
        state.inbox_issued = state.inbox_issued.max(inbox.seq);
    }
    let Some(outbox) = &snapshot.outbox else {
        return Ok(());
    };
    let manifest = &outbox.bundle.manifest;
    if manifest.seq < state.outbox_issued {
        return Ok(());
    }
    if let Some(seen) = &state.last_outbox {
        if manifest.seq == seen.sequence {
            if outbox.digest != seen.digest {
                return Err("outbox changed without a new sequence".into());
            }
            return Ok(());
        }
    }
    let acknowledged = manifest
        .last_inbox_seq
        .ok_or("outbox acknowledgement is missing")?;
    if acknowledged < state.inbox_acknowledged {
        return Ok(());
    }
    state.inbox_issued = state.inbox_issued.max(acknowledged);
    state.inbox_acknowledged = acknowledged;
    state.outbox_issued = state.outbox_issued.max(manifest.seq);
    // Creation or another computer may have published the inbox. Its exact
    // authenticated sequence and per-path hashes provide the same proof as a
    // locally retained pending snapshot; a bare acknowledgement never does.
    if let Some(inbox) = snapshot
        .inbox_manifest()
        .filter(|inbox| inbox.seq == acknowledged)
    {
        for entry in inbox.entries.iter().filter(|entry| entry.class.is_config()) {
            if manifest.entries.iter().any(|drive| {
                drive.path == entry.path
                    && drive.class == entry.class
                    && drive.sha256 == entry.sha256
            }) {
                state
                    .common_hashes
                    .insert(entry.path.clone(), entry.sha256.clone());
            }
        }
    }
    if let Some(pending) = &state.pending {
        if acknowledged >= pending.sequence {
            for entry in manifest
                .entries
                .iter()
                .filter(|entry| entry.class.is_config())
            {
                // lastInboxSeq alone cannot promote a path. Config may have been
                // partially applied or deferred to B's boot-side conflict prompt.
                if pending.proposed_hashes.get(&entry.path) == Some(&entry.sha256) {
                    state
                        .common_hashes
                        .insert(entry.path.clone(), entry.sha256.clone());
                }
            }
            state.pending = None;
        }
    }
    state.last_outbox = Some(OutboxSeen {
        sequence: manifest.seq,
        digest: outbox.digest.clone(),
    });
    Ok(())
}

fn selection_digest(
    snapshot: &SourceSnapshot,
    included: &BTreeSet<String>,
) -> Result<String, String> {
    let mut entries: Vec<_> = snapshot
        .bundle
        .manifest
        .entries
        .iter()
        .filter(|entry| included.contains(&entry.path))
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(sha256_hex(
        &serde_json::to_vec(&entries).map_err(|_| "cannot hash refresh selection")?,
    ))
}
fn state_digest(state: &FlowState) -> Result<String, String> {
    Ok(sha256_hex(
        &serde_json::to_vec(state).map_err(|_| "cannot hash flow state")?,
    ))
}
