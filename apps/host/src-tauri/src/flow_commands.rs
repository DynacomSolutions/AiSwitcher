//! Native integration for mounted exchange flows. The app installs a runtime
//! backed by its drive/source registries and existing local/SSH host adapter,
//! then registers these commands. No IPC argument is a path, key or write plan.

use ais_host_core::{
    exchange::MountedExchange,
    flow_adapter::{HostAdapter, HostTarget},
    flow_state::{DriveBinding, FlowStore},
    logs::{PullLogsResult, pull_logs},
    refresh::{
        FreshnessPolicy, PreparedRefresh, RefreshChoices, RefreshPreview, RefreshResult,
        prepare_refresh, publish_refresh,
    },
    remove::{
        RemovalBackend, RemoveJournal, RemoveOptions, RemoveResult, RemoveReview, RemoveReviewView,
        ResumeRemoval, acknowledge_removal_failures, execute_removal, prepare_removal,
        resume_removal_review,
    },
    reset,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Implement using native discovery and the existing requestHost adapter. All
/// returned diagnostics must be safe for display. A removal backend resolves
/// the drive's selected log receiver from durable native state, so reopening a
/// journal cannot silently select another receiver. Its revoke operation must
/// recheck grant fingerprints while holding the existing provider auth lock.
/// A configured place to read from or write logs to. The id is the only thing
/// IPC ever sends back; labels are for display.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowTarget {
    pub id: String,
    pub label: String,
    pub kind: &'static str,
}

pub trait FlowRuntime: Send {
    /// Include journal-only bindings from FileFlowStore after forgetting, so
    /// retained failures remain reviewable without recreating a drive record.
    fn resolve_drive(&mut self, handle: &str) -> Result<DriveBinding, String>;
    fn resolve_target(&mut self, handle: &str) -> Result<HostTarget, String>;
    fn targets(&mut self) -> Result<Vec<FlowTarget>, String>;
    fn open_exchange(&mut self, drive: &DriveBinding) -> Result<MountedExchange, String>;
    fn open_store(&mut self, drive: &DriveBinding) -> Result<Box<dyn FlowStore>, String>;
    fn adapter(&mut self) -> &mut dyn HostAdapter;
    fn removal_backend(&mut self, drive: &DriveBinding) -> Result<Box<dyn RemovalBackend>, String>;
    fn freshness(&self) -> FreshnessPolicy;
    fn created_at(&self) -> String;
    /// Called after every command, success or failure: unmount anything the
    /// command mounted. Previews hold no handle to a mounted volume.
    fn release(&mut self) {}
}

#[derive(Clone)]
pub struct FlowCommandState(Arc<Mutex<FlowSession>>);

struct FlowSession {
    runtime: Box<dyn FlowRuntime>,
    started: Instant,
    refresh: Option<PendingRefresh>,
    removal: Option<PendingRemoval>,
}

struct PendingRefresh {
    id: String,
    drive_handle: String,
    drive: DriveBinding,
    preview: PreparedRefresh,
    issued: Instant,
}
struct PendingRemoval {
    id: String,
    drive_handle: String,
    drive: DriveBinding,
    review: RemoveReview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshCommandPreview {
    pub preview_id: String,
    pub preview: RefreshPreview,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalCommandPreview {
    pub preview_id: String,
    pub review: RemoveReviewView,
}

impl FlowCommandState {
    pub fn new(runtime: Box<dyn FlowRuntime>) -> Self {
        Self(Arc::new(Mutex::new(FlowSession {
            runtime,
            started: Instant::now(),
            refresh: None,
            removal: None,
        })))
    }

    async fn run<T, F>(&self, action: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut FlowSession) -> Result<T, String> + Send + 'static,
    {
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut session = state.0.lock().map_err(|_| "Flow session is unavailable.")?;
            let result = action(&mut session);
            session.runtime.release();
            result
        })
        .await
        .map_err(|_| "Flow operation did not complete.".to_string())?
    }
}

fn preview_id() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Cannot create a flow preview.")?;
    Ok(ais_host_core::release::hex(&bytes))
}

fn check_handle(handle: &str) -> Result<(), String> {
    HostTarget::new(handle).map(|_| ())
}

impl FlowSession {
    fn invalidate(&mut self) {
        self.refresh = None;
        self.removal = None;
    }

    fn preview_refresh(
        &mut self,
        drive_id: &str,
        source_id: &str,
        choices: RefreshChoices,
    ) -> Result<RefreshCommandPreview, String> {
        self.invalidate();
        check_handle(drive_id)?;
        check_handle(source_id)?;
        let drive = self.runtime.resolve_drive(drive_id)?;
        let source = self.runtime.resolve_target(source_id)?;
        let exchange = self.runtime.open_exchange(&drive)?;
        let mut store = self.runtime.open_store(&drive)?;
        let freshness = self.runtime.freshness();
        let preview = prepare_refresh(
            &exchange,
            &mut *store,
            self.runtime.adapter(),
            source,
            freshness,
            choices,
        )?;
        let id = preview_id()?;
        let response = RefreshCommandPreview {
            preview_id: id.clone(),
            preview: preview.view().clone(),
        };
        self.refresh = Some(PendingRefresh {
            id,
            drive_handle: drive_id.to_owned(),
            drive,
            preview,
            issued: Instant::now(),
        });
        Ok(response)
    }

    fn publish(&mut self, id: &str) -> Result<RefreshResult, String> {
        let pending = self
            .refresh
            .take()
            .ok_or("Refresh preview is unavailable.")?;
        if id != pending.id || pending.issued.elapsed() >= Duration::from_secs(90) {
            return Err("Refresh preview changed or expired; review it again.".into());
        }
        let current = self.runtime.resolve_drive(&pending.drive_handle)?;
        if current != pending.drive {
            return Err("Drive generation changed; review it again.".into());
        }
        let exchange = self.runtime.open_exchange(&current)?;
        let mut store = self.runtime.open_store(&current)?;
        let created_at = self.runtime.created_at();
        publish_refresh(
            pending.preview,
            &exchange,
            &mut *store,
            self.runtime.adapter(),
            &created_at,
        )
    }

    fn preview_removal(
        &mut self,
        drive_id: &str,
        options: RemoveOptions,
        resume: bool,
    ) -> Result<RemovalCommandPreview, String> {
        self.invalidate();
        check_handle(drive_id)?;
        let drive = self.runtime.resolve_drive(drive_id)?;
        let now = self.started.elapsed().as_secs();
        let review = if resume {
            let mut store = self.runtime.open_store(&drive)?;
            let review = resume_removal_review(&mut *store, &drive, now)?;
            if review.view().options != options {
                return Err("Resumed removal choices must match its journal.".into());
            }
            review
        } else {
            let mut backend = self.runtime.removal_backend(&drive)?;
            prepare_removal(drive.clone(), options, &mut *backend, now)?
        };
        let id = preview_id()?;
        let response = RemovalCommandPreview {
            preview_id: id.clone(),
            review: review.view().clone(),
        };
        self.removal = Some(PendingRemoval {
            id,
            drive_handle: drive_id.to_owned(),
            drive,
            review,
        });
        Ok(response)
    }

    fn remove(
        &mut self,
        id: &str,
        digest: &str,
        consent: BTreeSet<String>,
        resume: ResumeRemoval,
    ) -> Result<RemoveResult, String> {
        let pending = self
            .removal
            .take()
            .ok_or("Removal preview is unavailable.")?;
        if id != pending.id {
            return Err("Removal preview changed; review it again.".into());
        }
        let current = self.runtime.resolve_drive(&pending.drive_handle)?;
        if current != pending.drive {
            return Err("Drive generation changed; review it again.".into());
        }
        let confirmed =
            pending
                .review
                .confirm(digest, consent, self.started.elapsed().as_secs())?;
        let mut store = self.runtime.open_store(&current)?;
        let mut backend = self.runtime.removal_backend(&current)?;
        execute_removal(&confirmed, &mut *store, &mut *backend, resume)
    }
}

#[tauri::command]
pub async fn flow_list_targets(
    state: tauri::State<'_, FlowCommandState>,
) -> Result<Vec<FlowTarget>, String> {
    state.run(|session| session.runtime.targets()).await
}

#[tauri::command]
pub async fn flow_refresh_preview(
    drive_id: String,
    source_id: String,
    choices: RefreshChoices,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<RefreshCommandPreview, String> {
    state
        .run(move |session| session.preview_refresh(&drive_id, &source_id, choices))
        .await
}

#[tauri::command]
pub async fn flow_refresh_publish(
    preview_id: String,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<RefreshResult, String> {
    state.run(move |session| session.publish(&preview_id)).await
}

#[tauri::command]
pub async fn flow_pull_logs(
    drive_id: String,
    destination_id: String,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<PullLogsResult, String> {
    state
        .run(move |session| {
            session.invalidate();
            check_handle(&drive_id)?;
            check_handle(&destination_id)?;
            let drive = session.runtime.resolve_drive(&drive_id)?;
            let destination = session.runtime.resolve_target(&destination_id)?;
            let exchange = session.runtime.open_exchange(&drive)?;
            let mut store = session.runtime.open_store(&drive)?;
            let freshness = session.runtime.freshness();
            pull_logs(
                &exchange,
                &mut *store,
                session.runtime.adapter(),
                &destination,
                freshness,
            )
        })
        .await
}

#[tauri::command]
pub async fn flow_remove_preview(
    drive_id: String,
    options: RemoveOptions,
    resume: bool,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<RemovalCommandPreview, String> {
    state
        .run(move |session| session.preview_removal(&drive_id, options, resume))
        .await
}

#[tauri::command]
pub async fn flow_remove_execute(
    preview_id: String,
    review_digest: String,
    consented_identities: BTreeSet<String>,
    resume: ResumeRemoval,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<RemoveResult, String> {
    state
        .run(move |session| {
            session.remove(&preview_id, &review_digest, consented_identities, resume)
        })
        .await
}

#[tauri::command]
pub async fn flow_removal_journal(
    drive_id: String,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<Option<RemoveJournal>, String> {
    state
        .run(move |session| {
            check_handle(&drive_id)?;
            let drive = session.runtime.resolve_drive(&drive_id)?;
            let mut store = session.runtime.open_store(&drive)?;
            let state = store.load(&drive)?;
            state.validate(&drive)?;
            Ok(state.removal().cloned())
        })
        .await
}

#[tauri::command]
pub async fn flow_acknowledge_failures(
    drive_id: String,
    review_digest: String,
    state: tauri::State<'_, FlowCommandState>,
) -> Result<(), String> {
    state
        .run(move |session| {
            session.invalidate();
            check_handle(&drive_id)?;
            let drive = session.runtime.resolve_drive(&drive_id)?;
            let mut store = session.runtime.open_store(&drive)?;
            acknowledge_removal_failures(&mut *store, &drive, &review_digest)
        })
        .await
}

#[tauri::command]
pub async fn flow_invalidate_preview(
    state: tauri::State<'_, FlowCommandState>,
) -> Result<(), String> {
    state
        .run(|session| {
            session.invalidate();
            Ok(())
        })
        .await
}

#[tauri::command]
pub fn flow_reset_support() -> reset::ResetSupport {
    reset::support()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ais_host_core::{
        flow_adapter::ImportSummary,
        flow_state::FlowState,
        revocation::{CredentialScope, RevocationBackend},
    };

    struct FakeStore(FlowState);
    impl FlowStore for FakeStore {
        fn load(&mut self, drive: &DriveBinding) -> Result<FlowState, String> {
            self.0.validate(drive)?;
            Ok(self.0.clone())
        }
        fn save(&mut self, state: &FlowState) -> Result<(), String> {
            self.0 = state.clone();
            Ok(())
        }
    }
    struct FakeRuntime;
    impl HostAdapter for FakeRuntime {
        fn export_snapshot(&mut self, _: &HostTarget) -> Result<Vec<u8>, String> {
            panic!("not selected")
        }
        fn import_logs(&mut self, _: &HostTarget, _: &[u8]) -> Result<ImportSummary, String> {
            panic!("not selected")
        }
    }
    impl RevocationBackend for FakeRuntime {
        fn inventory(&mut self, _: &DriveBinding) -> Result<Vec<CredentialScope>, String> {
            panic!("not selected")
        }
        fn revoke(&mut self, _: &CredentialScope) -> Result<(), String> {
            panic!("not selected")
        }
    }
    impl RemovalBackend for FakeRuntime {
        fn pull_logs(
            &mut self,
            _: &DriveBinding,
            _: &mut dyn FlowStore,
        ) -> Result<PullLogsResult, String> {
            panic!("not selected")
        }
        fn forget_drive(&mut self, _: &DriveBinding) -> Result<(), String> {
            panic!("not selected")
        }
    }
    impl FlowRuntime for FakeRuntime {
        fn resolve_drive(&mut self, handle: &str) -> Result<DriveBinding, String> {
            match handle {
                "SYNTHETIC_FIXTURE_handle" => DriveBinding::new("SYNTHETIC_FIXTURE_bound", 1),
                "SYNTHETIC_FIXTURE_bound" => Err("drive identity is not a native handle".into()),
                _ => DriveBinding::new(handle, 1),
            }
        }
        fn resolve_target(&mut self, handle: &str) -> Result<HostTarget, String> {
            HostTarget::new(handle)
        }
        fn targets(&mut self) -> Result<Vec<FlowTarget>, String> {
            Ok(vec![FlowTarget {
                id: "local".into(),
                label: "This computer".into(),
                kind: "local",
            }])
        }
        fn open_exchange(&mut self, _: &DriveBinding) -> Result<MountedExchange, String> {
            panic!("no mounted volume needed")
        }
        fn open_store(&mut self, drive: &DriveBinding) -> Result<Box<dyn FlowStore>, String> {
            Ok(Box::new(FakeStore(FlowState::new(drive.clone()))))
        }
        fn adapter(&mut self) -> &mut dyn HostAdapter {
            self
        }
        fn removal_backend(&mut self, _: &DriveBinding) -> Result<Box<dyn RemovalBackend>, String> {
            Ok(Box::new(FakeRuntime))
        }
        fn freshness(&self) -> FreshnessPolicy {
            panic!("not selected")
        }
        fn created_at(&self) -> String {
            panic!("not selected")
        }
    }
    fn session() -> FlowSession {
        FlowSession {
            runtime: Box::new(FakeRuntime),
            started: Instant::now(),
            refresh: None,
            removal: None,
        }
    }

    #[test]
    fn previews_are_single_use_and_invalid_identifiers_consume_them() {
        let mut session = session();
        let preview = session
            .preview_removal("SYNTHETIC_FIXTURE_drive", RemoveOptions::default(), false)
            .unwrap();
        session
            .remove(
                &preview.preview_id,
                &preview.review.digest,
                BTreeSet::new(),
                ResumeRemoval::default(),
            )
            .unwrap();
        assert!(
            session
                .remove(
                    &preview.preview_id,
                    &preview.review.digest,
                    BTreeSet::new(),
                    ResumeRemoval::default()
                )
                .is_err()
        );
        let preview = session
            .preview_removal("SYNTHETIC_FIXTURE_drive", RemoveOptions::default(), false)
            .unwrap();
        assert!(
            session
                .remove(
                    "SYNTHETIC_FIXTURE_wrong_preview",
                    &preview.review.digest,
                    BTreeSet::new(),
                    ResumeRemoval::default()
                )
                .is_err()
        );
        assert!(
            session
                .remove(
                    &preview.preview_id,
                    &preview.review.digest,
                    BTreeSet::new(),
                    ResumeRemoval::default()
                )
                .is_err()
        );
    }

    #[test]
    fn execution_rechecks_the_original_native_handle() {
        let mut session = session();
        let preview = session
            .preview_removal("SYNTHETIC_FIXTURE_handle", RemoveOptions::default(), false)
            .unwrap();
        assert_eq!(preview.review.drive.drive_id(), "SYNTHETIC_FIXTURE_bound");
        session
            .remove(
                &preview.preview_id,
                &preview.review.digest,
                BTreeSet::new(),
                ResumeRemoval::default(),
            )
            .unwrap();
    }

    #[test]
    fn previews_expire_and_renderer_paths_are_not_native_handles() {
        let mut session = session();
        let preview = session
            .preview_removal("SYNTHETIC_FIXTURE_drive", RemoveOptions::default(), false)
            .unwrap();
        session.started = Instant::now() - Duration::from_secs(91);
        assert!(
            session
                .remove(
                    &preview.preview_id,
                    &preview.review.digest,
                    BTreeSet::new(),
                    ResumeRemoval::default()
                )
                .is_err()
        );
        assert!(
            session
                .preview_removal("../SYNTHETIC_FIXTURE", RemoveOptions::default(), false)
                .is_err()
        );
        assert!(
            session
                .preview_refresh(
                    "SYNTHETIC_FIXTURE_drive",
                    "/SYNTHETIC_FIXTURE",
                    RefreshChoices::default()
                )
                .is_err()
        );
        assert!(session.refresh.is_none() && session.removal.is_none());
    }

    #[test]
    fn targets_are_listed_by_opaque_id_and_label_only() {
        let mut session = session();
        let targets = session.runtime.targets().unwrap();
        assert_eq!(targets.len(), 1);
        let json = serde_json::to_value(&targets[0]).unwrap();
        assert_eq!(json["id"], "local");
        assert_eq!(json["kind"], "local");
        assert_eq!(json.as_object().unwrap().len(), 3);
    }

    #[test]
    fn reset_support_follows_the_platform_and_removal_defers_to_it() {
        assert_eq!(flow_reset_support().supported, cfg!(target_os = "linux"));
        assert!(!reset::removal_support().supported);
    }
}
