//! Independently selected removal actions. Raw persist operations deliberately
//! are never performed here: they use the confirmed Reset storage flow.

use crate::{
    contract::sha256_hex,
    escrow::{Clock, EscrowService, EscrowStore, RetentionClock},
    flow_state::{DriveBinding, FlowStore, valid_hash},
    logs::PullLogsResult,
    registry::RegistryStorage,
    reset,
    revocation::{
        ProviderRevocationResult, RevocationBackend, RevocationEffect, RevocationReview, revoke_one,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveOptions {
    pub pull_logs: bool,
    pub erase_storage: bool,
    pub revoke_credentials: bool,
    pub forget_drive: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum StepResult {
    Completed,
    Failed { reason: String },
    Skipped { reason: String },
}
impl StepResult {
    pub fn completed(&self) -> bool {
        matches!(self, Self::Completed)
    }
    pub fn failed(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveResult {
    pub pull_logs: StepResult,
    pub erase_storage: StepResult,
    pub revoke_credentials: StepResult,
    pub forget_drive: StepResult,
    pub providers: Vec<ProviderRevocationResult>,
    pub paused_for_logs: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveJournal {
    binding: DriveBinding,
    review_digest: String,
    options: RemoveOptions,
    credentials: RevocationReview,
    pub result: RemoveResult,
    continued_without_logs: bool,
    failures_seen: bool,
}

impl RemoveJournal {
    pub(crate) fn validate(&self, binding: &DriveBinding) -> Result<(), String> {
        if &self.binding != binding
            || !valid_hash(&self.review_digest)
            || self.result.providers.len() > 1024
        {
            return Err("invalid removal journal".into());
        }
        self.credentials.validate(binding)?;
        let mut providers = BTreeSet::new();
        if (!self.options.revoke_credentials && !self.credentials.scopes.is_empty())
            || self.result.providers.iter().any(|result| {
                !providers.insert(&result.handle)
                    || !self.credentials.scopes.iter().any(|scope| {
                        scope.handle == result.handle && scope.provider == result.provider
                    })
            })
        {
            return Err("removal journal contains an unreviewed credential".into());
        }
        Ok(())
    }
    pub fn failures_seen(&self) -> bool {
        self.failures_seen
    }
    pub fn review_digest(&self) -> &str {
        &self.review_digest
    }
    fn has_failures(&self) -> bool {
        [
            &self.result.pull_logs,
            &self.result.erase_storage,
            &self.result.revoke_credentials,
            &self.result.forget_drive,
        ]
        .iter()
        .any(|s| s.failed())
    }
}

pub trait RemovalBackend: RevocationBackend {
    /// Resolve the already selected native receiver; never default to a broader
    /// target. Use logs::pull_logs and its existing local/SSH adapter bridge.
    fn pull_logs(
        &mut self,
        drive: &DriveBinding,
        store: &mut dyn FlowStore,
    ) -> Result<PullLogsResult, String>;
    /// Use forget_drive_record below. This deletes app state and escrow only.
    fn forget_drive(&mut self, drive: &DriveBinding) -> Result<(), String>;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReviewView {
    pub drive: DriveBinding,
    pub options: RemoveOptions,
    pub credentials: RevocationReview,
    pub digest: String,
    pub erase_support: reset::ResetSupport,
}

pub struct RemoveReview {
    view: RemoveReviewView,
    issued_at: u64,
}
pub struct ConfirmedRemoval {
    view: RemoveReviewView,
    consented_identities: BTreeSet<String>,
}

impl RemoveReview {
    pub fn view(&self) -> &RemoveReviewView {
        &self.view
    }
    /// Native monotonic seconds, with an exact retained review digest. No disk
    /// authorisation is created: unavailable erasure always fails closed.
    pub fn confirm(
        self,
        digest: &str,
        consented_identities: BTreeSet<String>,
        now: u64,
    ) -> Result<ConfirmedRemoval, String> {
        if digest != self.view.digest || now < self.issued_at || now - self.issued_at >= 90 {
            return Err(
                "removal review changed or expired; review the selected steps again".into(),
            );
        }
        let reviewed: BTreeSet<_> = self
            .view
            .credentials
            .scopes
            .iter()
            .flat_map(|scope| scope.affected_identities.iter().cloned())
            .collect();
        if !consented_identities.is_subset(&reviewed) {
            return Err("consent contains an identity outside the review".into());
        }
        Ok(ConfirmedRemoval {
            view: self.view,
            consented_identities,
        })
    }
}

pub fn prepare_removal(
    drive: DriveBinding,
    options: RemoveOptions,
    backend: &mut dyn RemovalBackend,
    now: u64,
) -> Result<RemoveReview, String> {
    drive.validate()?;
    let credentials = if options.revoke_credentials {
        RevocationReview::prepare(backend, &drive)?
    } else {
        RevocationReview::empty(&drive)?
    };
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "cannot create removal review")?;
    let digest = sha256_hex(
        &serde_json::to_vec(&(&drive, options, &credentials, nonce))
            .map_err(|_| "cannot identify removal review")?,
    );
    Ok(RemoveReview {
        view: RemoveReviewView {
            drive,
            options,
            credentials,
            digest,
            erase_support: reset::removal_support(),
        },
        issued_at: now,
    })
}

/// Reopen an interrupted journal without broadening its choices. The user must
/// confirm this newly displayed review, and each credential is rechecked again.
pub fn resume_removal_review(
    store: &mut dyn FlowStore,
    drive: &DriveBinding,
    now: u64,
) -> Result<RemoveReview, String> {
    let state = store.load(drive)?;
    state.validate(drive)?;
    let journal = state.removal.ok_or("removal journal is missing")?;
    Ok(RemoveReview {
        view: RemoveReviewView {
            drive: drive.clone(),
            options: journal.options,
            credentials: journal.credentials,
            digest: journal.review_digest,
            erase_support: reset::removal_support(),
        },
        issued_at: now,
    })
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeRemoval {
    #[serde(default)]
    pub retry_failed_logs: bool,
    #[serde(default)]
    pub continue_without_logs: bool,
}

pub fn execute_removal(
    confirmed: &ConfirmedRemoval,
    store: &mut dyn FlowStore,
    backend: &mut dyn RemovalBackend,
    resume: ResumeRemoval,
) -> Result<RemoveResult, String> {
    if resume.retry_failed_logs && resume.continue_without_logs {
        return Err("choose retry logs or continue without logs".into());
    }
    let drive = &confirmed.view.drive;
    let mut state = store.load(drive)?;
    state.validate(drive)?;
    let options = confirmed.view.options;
    if state
        .removal
        .as_ref()
        .is_none_or(|j| j.review_digest != confirmed.view.digest)
    {
        if state
            .removal
            .as_ref()
            .is_some_and(|j| j.has_failures() && !j.failures_seen)
        {
            return Err(
                "review the previous removal failures before starting another removal".into(),
            );
        }
        if resume.continue_without_logs {
            return Err("continuing without logs requires an earlier failed log pull".into());
        }
        let initial = |selected| StepResult::Skipped {
            reason: if selected {
                "Not attempted"
            } else {
                "Not selected"
            }
            .into(),
        };
        state.removal = Some(RemoveJournal {
            binding: drive.clone(),
            review_digest: confirmed.view.digest.clone(),
            options,
            credentials: confirmed.view.credentials.clone(),
            result: RemoveResult {
                pull_logs: initial(options.pull_logs),
                erase_storage: initial(options.erase_storage),
                revoke_credentials: initial(options.revoke_credentials),
                forget_drive: initial(options.forget_drive),
                providers: Vec::new(),
                paused_for_logs: false,
            },
            continued_without_logs: false,
            failures_seen: false,
        });
        store.save(&state)?;
    }
    let mut journal = state.removal.clone().ok_or("removal journal is missing")?;
    if journal.options != options {
        return Err("removal options changed after confirmation".into());
    }
    let persist = |journal: &RemoveJournal,
                   state: &mut crate::flow_state::FlowState,
                   store: &mut dyn FlowStore| {
        state.removal = Some(journal.clone());
        store.save(state)
    };
    if resume.continue_without_logs {
        if !journal.result.pull_logs.failed() {
            return Err("there is no failed log pull to skip".into());
        }
        journal.continued_without_logs = true;
        persist(&journal, &mut state, store)?;
    }
    if options.pull_logs
        && !journal.result.pull_logs.completed()
        && !journal.continued_without_logs
        && (!journal.result.pull_logs.failed() || resume.retry_failed_logs)
    {
        journal.result.pull_logs = match backend.pull_logs(drive, store) {
            Ok(result) if result.complete => StepResult::Completed,
            _ => StepResult::Failed {
                reason:
                    "Log retrieval is incomplete. Retry or explicitly continue without these logs."
                        .into(),
            },
        };
        // Log import may have durably added a receipt to this same locked store.
        state = store.load(drive)?;
        state.validate(drive)?;
        if journal.result.pull_logs.failed() {
            journal.failures_seen = false;
        }
        persist(&journal, &mut state, store)?;
    }
    journal.result.paused_for_logs = options.pull_logs
        && !journal.result.pull_logs.completed()
        && !journal.continued_without_logs;
    if journal.result.paused_for_logs {
        persist(&journal, &mut state, store)?;
        return Ok(journal.result);
    }
    if options.erase_storage && !journal.result.erase_storage.completed() {
        journal.result.erase_storage = StepResult::Failed {
            reason: reset::removal_support().reason.into(),
        };
        journal.failures_seen = false;
        persist(&journal, &mut state, store)?;
    }
    if options.revoke_credentials && !journal.result.revoke_credentials.completed() {
        for scope in &confirmed.view.credentials.scopes {
            if journal.result.providers.iter().any(|p| {
                p.handle == scope.handle
                    && matches!(
                        p.effect,
                        RevocationEffect::GrantRevoked | RevocationEffect::LocalCredentialDeleted
                    )
            }) {
                continue;
            }
            let result = revoke_one(backend, drive, &confirmed.view.credentials, &scope.handle, &confirmed.consented_identities)
                .unwrap_or_else(|_| ProviderRevocationResult { handle: scope.handle.clone(), provider: scope.provider.clone(), effect: RevocationEffect::Failed, next_action: Some("Authentication scope changed or is unavailable. Review affected identities again.".into()) });
            journal
                .result
                .providers
                .retain(|p| p.handle != scope.handle);
            journal.result.providers.push(result);
            journal.failures_seen = false;
            // Preserve each outcome before trying another grant or forgetting.
            persist(&journal, &mut state, store)?;
        }
        journal.result.revoke_credentials = if journal.result.providers.iter().all(|p| {
            matches!(
                p.effect,
                RevocationEffect::GrantRevoked | RevocationEffect::LocalCredentialDeleted
            )
        }) {
            StepResult::Completed
        } else {
            StepResult::Failed {
                reason: "Some authentication actions need attention. Review the provider results."
                    .into(),
            }
        };
        persist(&journal, &mut state, store)?;
    }
    if options.forget_drive && !journal.result.forget_drive.completed() {
        journal.result.forget_drive = match backend.forget_drive(drive) {
            Ok(()) => StepResult::Completed,
            Err(_) => StepResult::Failed { reason: "Drive record or escrow deletion is incomplete. Unlock the credential store and retry.".into() },
        };
        if journal.result.forget_drive.failed() {
            journal.failures_seen = false;
        }
        persist(&journal, &mut state, store)?;
    }
    persist(&journal, &mut state, store)?;
    Ok(journal.result)
}

pub fn acknowledge_removal_failures(
    store: &mut dyn FlowStore,
    drive: &DriveBinding,
    review_digest: &str,
) -> Result<(), String> {
    let mut state = store.load(drive)?;
    state.validate(drive)?;
    let journal = state.removal.as_mut().ok_or("removal journal is missing")?;
    if journal.review_digest != review_digest {
        return Err("removal journal changed".into());
    }
    journal.failures_seen = true;
    store.save(&state)
}

/// Concrete forgetting operation. It never retires an identity, touches the
/// exchange, revokes provider grants or deletes another generation's escrow.
pub fn forget_drive_record<B: EscrowStore, R: RegistryStorage, C: Clock>(
    backend: &mut B,
    registry: &mut R,
    clock: &RetentionClock<C>,
    drive: &DriveBinding,
) -> Result<(), String> {
    let records = registry.load().map_err(|_| "cannot read drive registry")?;
    records.validate().map_err(|_| "invalid drive registry")?;
    let Some(record) = records.record(drive.drive_id()) else {
        return Ok(());
    };
    if DriveBinding::from_record(record)? != *drive {
        return Err("drive generation changed; refusing to forget a different generation".into());
    }
    EscrowService::new(backend, registry, clock)
        .forget(drive.drive_id())
        .map_err(|_| "escrow deletion is pending; unlock the credential store and retry".into())
}
