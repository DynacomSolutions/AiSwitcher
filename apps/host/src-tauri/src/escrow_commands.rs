//! Secret-free escrow IPC. The coordinator registers these commands and creates
//! the private registry directory via the established native app data root.
//! Creation/refresh pipelines call EscrowService in Rust after verified writes;
//! no command accepts a passphrase, caller-supplied directory or retention edit.

use ais_host_core::create::{Passphrase, PassphraseSink};
use ais_host_core::escrow::{EscrowPolicy, SecretString};
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

impl EscrowCommandState {
    pub fn known_images(
        &self,
    ) -> Result<Vec<(ais_host_core::update::InstalledImage, String)>, String> {
        let mut registry =
            FileRegistry::open(&self.directory).map_err(|error| error.to_string())?;
        let data = registry.load().map_err(|error| error.to_string())?;
        Ok(data
            .records()
            .filter(|record| record.created_here() && !record.forget_pending())
            .filter_map(|record| {
                record.installed_image().map(|image| {
                    (
                        image.clone(),
                        record.image_update_status().unwrap_or("created").into(),
                    )
                })
            })
            .collect())
    }
    /// Retention stays disabled, so creation keeps only a secret-free drive record.
    pub fn sink(&self) -> EscrowSink {
        EscrowSink {
            state: self.clone(),
            policy: EscrowPolicy::Disabled,
        }
    }
}

pub struct EscrowSink {
    state: EscrowCommandState,
    policy: EscrowPolicy,
}

impl PassphraseSink for EscrowSink {
    fn remember_image(
        &self,
        drive_id: &str,
        image: &ais_host_core::update::InstalledImage,
        status: &str,
    ) -> Result<(), String> {
        let mut registry =
            FileRegistry::open(&self.state.directory).map_err(|error| error.to_string())?;
        let mut data = registry.load().map_err(|error| error.to_string())?;
        data.record_image(drive_id, image.clone(), status)
            .map_err(|error| error.to_string())?;
        registry.save(&data).map_err(|error| error.to_string())
    }
    fn reserve_update_sequence(&self, drive_id: &str, minimum: u64) -> Result<u64, String> {
        let mut registry =
            FileRegistry::open(&self.state.directory).map_err(|error| error.to_string())?;
        let mut data = registry.load().map_err(|error| error.to_string())?;
        let seq = data
            .reserve_update_inbox(drive_id, minimum)
            .map_err(|error| error.to_string())?;
        registry.save(&data).map_err(|error| error.to_string())?;
        Ok(seq)
    }

    fn hand_over(&self, passphrase: &Passphrase, drive_id: &str) -> Result<(), String> {
        let mut registry =
            FileRegistry::open(&self.state.directory).map_err(|error| error.to_string())?;
        let secret = matches!(self.policy, EscrowPolicy::Until(_))
            .then(|| SecretString::from(passphrase.expose().to_owned()));
        EscrowService::new(&mut NativeStore, &mut registry, &self.state.clock)
            .create_drive(drive_id, self.policy, Vec::new(), secret.as_ref())
            .map(|_| ())
            .map_err(|error| error.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handing_over_records_the_drive_without_retaining_the_passphrase() {
        let directory =
            std::env::temp_dir().join(format!("ais-escrow-sink-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let state = EscrowCommandState::new(directory.clone()).unwrap();
        let passphrase =
            Passphrase::new("SYNTHETIC_FIXTURE_12".into(), "SYNTHETIC_FIXTURE_12").unwrap();
        state
            .sink()
            .hand_over(&passphrase, "synthetic-drive-1")
            .unwrap();
        let mut registry = FileRegistry::open(&directory).unwrap();
        let data = registry.load().unwrap();
        let record = data.record("synthetic-drive-1").unwrap();
        assert!(record.item().is_none());
        assert!(record.created_here());
        // A second hand-over for the same drive is refused rather than replaced.
        drop(registry);
        assert!(
            state
                .sink()
                .hand_over(&passphrase, "synthetic-drive-1")
                .is_err()
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
