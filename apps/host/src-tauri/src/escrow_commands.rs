//! Secret-free escrow IPC. The coordinator registers these commands and creates
//! the private registry directory via the established native app data root.
//! Creation/refresh pipelines call EscrowService in Rust after verified writes;
//! no command accepts a passphrase, caller-supplied directory or retention edit.

use ais_host_core::{
    escrow::{
        EscrowError, EscrowService, PurgeResult, RetentionClock, SystemClock,
        native::{NativeDeleter, NativeStore},
        purge_expired,
    },
    registry::{DriveRecord, FileRegistry, RegistryStorage},
};
use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
pub struct EscrowCommandState {
    directory: PathBuf,
    clock: Arc<RetentionClock<SystemClock>>,
}

impl EscrowCommandState {
    pub fn new(native_directory: PathBuf) -> Result<Self, EscrowError> {
        // Check ownership/permissions before exposing any commands.
        FileRegistry::open(&native_directory)?;
        Ok(Self {
            directory: native_directory,
            clock: Arc::new(RetentionClock::new(SystemClock::default())),
        })
    }

    /// Also call on startup, resume and credential-store availability. Keeping
    /// this state alive preserves the monotonic deadline across operations.
    pub fn purge(&self) -> Result<PurgeResult, EscrowError> {
        let mut registry = FileRegistry::open(&self.directory)?;
        purge_expired(&mut NativeDeleter, &mut registry, &self.clock)
    }
}

#[tauri::command]
pub async fn escrow_drive_records(
    state: tauri::State<'_, EscrowCommandState>,
) -> Result<Vec<DriveRecord>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.purge()?;
        let mut registry = FileRegistry::open(&state.directory)?;
        Ok::<_, EscrowError>(registry.load()?.records().cloned().collect())
    })
    .await
    .map_err(|_| EscrowError::Unavailable.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn escrow_purge(
    state: tauri::State<'_, EscrowCommandState>,
) -> Result<PurgeResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.purge())
        .await
        .map_err(|_| EscrowError::Unavailable.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn escrow_delete(
    drive_id: String,
    state: tauri::State<'_, EscrowCommandState>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut registry = FileRegistry::open(&state.directory)?;
        EscrowService::new(&mut NativeStore, &mut registry, &state.clock).delete(&drive_id)
    })
    .await
    .map_err(|_| EscrowError::Unavailable.to_string())?
    .map_err(|error| error.to_string())
}
