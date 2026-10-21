//! Secret-free escrow IPC. The coordinator registers these commands and creates
//! the private registry directory via the established native app data root.
//! Creation/refresh pipelines call EscrowService in Rust after verified writes;
//! no command accepts a passphrase, caller-supplied directory or retention edit.

use ais_host_core::create::{Passphrase, PassphraseSink};
use ais_host_core::escrow::{Clock, EscrowPolicy, SecretString};
use ais_host_core::{
    escrow::{
        EscrowError, EscrowService, PurgeResult, RetentionClock, SystemClock,
        native::{NativeDeleter, NativeStore},
        purge_expired,
    },
    registry::{DriveRecord, FileRegistry, RegistryStorage},
};
use std::{path::PathBuf, sync::Arc};

/// How long the creating computer keeps a drive passphrase for refresh and log
/// pulls. The expiry is fixed at creation and cannot be extended.
pub const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Windows stays disabled until its Credential Manager path is exercised on a
/// real machine; Linux uses Secret Service, macOS the login keychain.
const NATIVE_ESCROW_PLATFORM: bool = cfg!(any(target_os = "linux", target_os = "macos"));

/// Retain only when the platform backend is supported and currently usable;
/// otherwise creation keeps a secret-free record and the passphrase is session-only.
/// `agent_registered` is true only when the expiry agent is installed, so a
/// retained passphrase is always deleted on time even while the app is closed.
pub fn select_policy(
    platform_supported: bool,
    store_usable: bool,
    agent_registered: bool,
    now: u64,
) -> EscrowPolicy {
    if platform_supported && store_usable && agent_registered {
        EscrowPolicy::Until(now.saturating_add(RETENTION_SECONDS))
    } else {
        EscrowPolicy::Disabled
    }
}

#[derive(Clone)]
pub struct EscrowCommandState {
    directory: PathBuf,
    clock: Arc<RetentionClock<SystemClock>>,
    native_escrow: bool,
    agent: Option<Arc<dyn crate::escrow_agent::AgentInstaller>>,
}

impl EscrowCommandState {
    pub fn new(native_directory: PathBuf) -> Result<Self, EscrowError> {
        // Check ownership/permissions before exposing any commands.
        FileRegistry::open(&native_directory)?;
        Ok(Self {
            directory: native_directory,
            clock: Arc::new(RetentionClock::new(SystemClock::default())),
            native_escrow: false,
            agent: None,
        })
    }

    /// Production only: tests and unsupported platforms never touch a credential store.
    pub fn with_native_escrow(
        mut self,
        agent: Arc<dyn crate::escrow_agent::AgentInstaller>,
    ) -> Self {
        self.native_escrow = NATIVE_ESCROW_PLATFORM;
        self.agent = Some(agent);
        self
    }

    pub(crate) fn directory(&self) -> &std::path::Path {
        &self.directory
    }
    pub(crate) fn clock(&self) -> &RetentionClock<SystemClock> {
        &self.clock
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
    /// Checked per creation so a locked or absent credential store degrades to
    /// a secret-free drive record instead of failing the create flow.
    pub fn sink(&self) -> EscrowSink {
        let usable = self.native_escrow && NativeStore.availability().is_ok();
        // Only installed (or re-checked) once retention would otherwise be used.
        let registered = usable
            && self
                .agent
                .as_ref()
                .is_some_and(|agent| agent.ensure_installed(&self.directory).is_ok());
        let now = SystemClock::default().wall_seconds();
        EscrowSink {
            state: self.clone(),
            policy: select_policy(self.native_escrow, usable, registered, now),
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

    fn reset_drive(&self, drive_id: &str) -> Result<(), String> {
        let mut registry =
            FileRegistry::open(&self.state.directory).map_err(|error| error.to_string())?;
        // The new passphrase is chosen at the next boot and is never seen here.
        EscrowService::new(&mut NativeStore, &mut registry, &self.state.clock)
            .reset_drive(drive_id, EscrowPolicy::Disabled, None)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn hand_over(&self, passphrase: &Passphrase, drive_id: &str) -> Result<(), String> {
        let mut registry =
            FileRegistry::open(&self.state.directory).map_err(|error| error.to_string())?;
        let secret = matches!(self.policy, EscrowPolicy::Until(_))
            .then(|| SecretString::from(passphrase.expose().to_owned()));
        EscrowService::new(&mut NativeStore, &mut registry, &self.state.clock)
            .create_drive(
                drive_id,
                self.policy,
                // Logs pull to the install that created the drive unless another receiver is chosen.
                vec![crate::flow_runtime::LOCAL_TARGET.to_owned()],
                secret.as_ref(),
            )
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
        assert_eq!(record.retention(), EscrowPolicy::Disabled);
        assert_eq!(record.source_references(), ["local"]);
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

    struct FailingAgent;
    impl crate::escrow_agent::AgentInstaller for FailingAgent {
        fn ensure_installed(&self, _: &std::path::Path) -> Result<(), String> {
            Err("no agent".into())
        }
    }

    #[test]
    fn an_agent_that_cannot_be_installed_disables_retention() {
        let directory =
            std::env::temp_dir().join(format!("ais-escrow-agent-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let state = EscrowCommandState::new(directory.clone())
            .unwrap()
            .with_native_escrow(std::sync::Arc::new(FailingAgent));
        // Whatever the credential store reports, a failed agent never yields Until.
        assert_eq!(state.sink().policy, EscrowPolicy::Disabled);
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn policy_retains_only_with_a_supported_usable_store() {
        let now = 1_000;
        assert_eq!(
            select_policy(true, true, true, now),
            EscrowPolicy::Until(now + RETENTION_SECONDS)
        );
        for (platform, store, agent) in [
            (true, false, true),
            (false, true, true),
            (true, true, false),
            (false, false, false),
        ] {
            assert_eq!(
                select_policy(platform, store, agent, now),
                EscrowPolicy::Disabled
            );
        }
        assert_eq!(
            select_policy(true, true, true, u64::MAX),
            EscrowPolicy::Until(u64::MAX)
        );
    }

    #[test]
    fn native_escrow_is_off_unless_requested_and_off_on_windows() {
        let directory =
            std::env::temp_dir().join(format!("ais-escrow-policy-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let state = EscrowCommandState::new(directory.clone()).unwrap();
        assert_eq!(state.sink().policy, EscrowPolicy::Disabled);
        assert_eq!(
            state
                .with_native_escrow(std::sync::Arc::new(FailingAgent))
                .native_escrow,
            cfg!(any(target_os = "linux", target_os = "macos"))
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn reset_starts_a_new_generation_and_keeps_the_installed_release() {
        let directory =
            std::env::temp_dir().join(format!("ais-escrow-reset-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let state = EscrowCommandState::new(directory.clone()).unwrap();
        let passphrase =
            Passphrase::new("SYNTHETIC_FIXTURE_12".into(), "SYNTHETIC_FIXTURE_12").unwrap();
        let sink = state.sink();
        sink.hand_over(&passphrase, "synthetic-drive-1").unwrap();
        let installed = ais_host_core::update::InstalledImage {
            identity: ais_host_core::drive_identity::DriveIdentity::fresh().unwrap(),
            release_order: (1, 1),
            tag: "live-v1".into(),
            image_digest: [7; 32],
            hardware_hint: "a".repeat(64),
        };
        sink.remember_image("synthetic-drive-1", &installed, "created")
            .unwrap();
        assert!(sink.reset_drive("synthetic-drive-2").is_err());
        sink.reset_drive("synthetic-drive-1").unwrap();
        let mut registry = FileRegistry::open(&directory).unwrap();
        let data = registry.load().unwrap();
        let record = data.record("synthetic-drive-1").unwrap();
        assert_eq!(record.generation(), 2);
        assert!(record.item().is_none() && record.created_here());
        assert_eq!(record.installed_image(), Some(&installed));
        assert_eq!(record.image_update_status(), Some("created"));
        assert_eq!(record.source_references(), ["local"]);
        drop(registry);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
