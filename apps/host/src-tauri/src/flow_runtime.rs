//! The production FlowRuntime: drives come from the private registry, targets
//! from the user's `ais sync` remotes, and every host request goes through the
//! existing `ais host --stdio` protocol (locally or over strict-host-key SSH).

use crate::{
    escrow_commands::EscrowCommandState,
    flow_commands::{FlowRuntime, FlowTarget},
};
use ais_host_core::{
    escrow::{EscrowService, native::NativeStore},
    exchange::MountedExchange,
    flow_adapter::{HostAdapter, HostTarget},
    flow_state::{DriveBinding, FileFlowStore, FlowStore},
    local_adapter::{HostSource, ProcessHostAdapter, valid_ssh_alias},
    logs::{PullLogsResult, pull_logs},
    refresh::FreshnessPolicy,
    registry::{FileRegistry, RegistryStorage},
    remove::{RemovalBackend, forget_drive_record},
    revocation::{CredentialScope, RevocationBackend},
};
use std::path::{Path, PathBuf};

pub const LOCAL_TARGET: &str = "local";
const SSH_PREFIX: &str = "ssh-";
const MAX_OUTBOX_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Resolves the mounted exchange volume and its public identity manifest for a
/// drive. Neither the renderer nor the registry supplies a path.
pub type LocateExchange = fn(&DriveBinding) -> Result<(PathBuf, String), String>;

/// shortcut: volume discovery is not implemented, because creation does not yet
/// write the public identity manifest this lookup would read; wire it up with
/// that manifest (and a mount lookup) rather than guessing a location.
pub fn exchange_volume_unavailable(_: &DriveBinding) -> Result<(PathBuf, String), String> {
    Err("The drive's exchange volume is not available.".into())
}

fn hex_encode(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(2) {
        return None;
    }
    let raw: Option<Vec<u8>> = bytes
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect();
    String::from_utf8(raw?).ok()
}

/// Same file and rules as src/sync/config.ts; aliases outside the host pattern
/// are ignored rather than trusted.
pub fn sync_config_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AIS_SYNC_CONFIG").filter(|p| !p.is_empty()) {
        return Some(path.into());
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(Path::new(&home).join(".ais/config/sync-v2.json"))
}

pub fn read_remotes(path: &Path) -> Result<Vec<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => bytes,
        Ok(_) => return Err("The sync configuration is too large.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("The sync configuration cannot be read.".into()),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The sync configuration is not valid.".to_string())?;
    let mut remotes: Vec<String> = Vec::new();
    for item in value["remotes"].as_array().into_iter().flatten() {
        let alias = item.as_str().filter(|alias| valid_ssh_alias(alias));
        if let Some(alias) = alias.filter(|alias| 2 * alias.len() + SSH_PREFIX.len() <= 128)
            && !remotes.iter().any(|known| known == alias)
        {
            remotes.push(alias.to_owned());
        }
    }
    Ok(remotes)
}

pub fn target_for_alias(alias: &str) -> String {
    format!("{SSH_PREFIX}{}", hex_encode(alias))
}

/// Map an opaque handle to a source, requiring SSH hosts to be configured sync remotes.
pub fn resolve_source(handle: &str, remotes: &[String]) -> Result<HostSource, String> {
    if handle == LOCAL_TARGET {
        return Ok(HostSource::Local);
    }
    let alias = handle
        .strip_prefix(SSH_PREFIX)
        .and_then(hex_decode)
        .filter(|alias| valid_ssh_alias(alias) && remotes.contains(alias))
        .ok_or("The selected host is not configured.")?;
    Ok(HostSource::Ssh(alias))
}

fn current_source(handle: &str) -> Result<HostSource, String> {
    let remotes = match (handle == LOCAL_TARGET, sync_config_path()) {
        (true, _) => Vec::new(),
        (false, Some(path)) => read_remotes(&path)?,
        (false, None) => Vec::new(),
    };
    resolve_source(handle, &remotes)
}

fn process_adapter() -> ProcessHostAdapter {
    ProcessHostAdapter::new(|target: &HostTarget| current_source(target.handle()))
}

#[derive(Clone)]
struct Parts {
    escrow: EscrowCommandState,
    locate: LocateExchange,
}

impl Parts {
    fn open_exchange(&self, drive: &DriveBinding) -> Result<MountedExchange, String> {
        let (mount, manifest) = (self.locate)(drive)?;
        let mut registry = FileRegistry::open(self.escrow.directory())
            .map_err(|_| "The private drive registry is unavailable.".to_string())?;
        let passphrase = EscrowService::new(&mut NativeStore, &mut registry, self.escrow.clock())
            .retrieve(drive.drive_id())
            .map_err(|error| error.to_string())?;
        drop(registry);
        MountedExchange::open(mount, &manifest, drive.clone(), passphrase)
    }

    fn receiver(&self, drive: &DriveBinding) -> Result<HostTarget, String> {
        let mut registry = FileRegistry::open(self.escrow.directory())
            .map_err(|_| "The private drive registry is unavailable.".to_string())?;
        let data = registry
            .load()
            .map_err(|_| "The private drive registry is unavailable.".to_string())?;
        match data
            .record(drive.drive_id())
            .map(|record| record.source_references())
        {
            Some([only]) => HostTarget::new(only.as_str()),
            _ => Err("No log receiver was selected for this drive.".into()),
        }
    }
}

pub struct NativeFlowRuntime {
    parts: Parts,
    adapter: ProcessHostAdapter,
}

impl NativeFlowRuntime {
    pub fn new(escrow: EscrowCommandState) -> Self {
        Self::with_locator(escrow, exchange_volume_unavailable)
    }

    pub fn with_locator(escrow: EscrowCommandState, locate: LocateExchange) -> Self {
        Self {
            parts: Parts { escrow, locate },
            adapter: process_adapter(),
        }
    }
}

impl FlowRuntime for NativeFlowRuntime {
    fn resolve_drive(&mut self, handle: &str) -> Result<DriveBinding, String> {
        let directory = self.parts.escrow.directory();
        {
            let mut registry = FileRegistry::open(directory)
                .map_err(|_| "The private drive registry is unavailable.".to_string())?;
            let data = registry
                .load()
                .map_err(|_| "The private drive registry is unavailable.".to_string())?;
            if let Some(record) = data.record(handle) {
                return DriveBinding::from_record(record);
            }
        }
        // A forgotten drive stays reviewable while its removal journal is retained.
        FileFlowStore::open(directory.to_owned())?
            .retained_removal_bindings()?
            .into_iter()
            .rfind(|binding| binding.drive_id() == handle)
            .ok_or_else(|| "The drive is not registered.".into())
    }

    fn resolve_target(&mut self, handle: &str) -> Result<HostTarget, String> {
        let target = HostTarget::new(handle)?;
        current_source(handle)?;
        Ok(target)
    }

    fn targets(&mut self) -> Result<Vec<FlowTarget>, String> {
        let remotes = match sync_config_path() {
            Some(path) => read_remotes(&path)?,
            None => Vec::new(),
        };
        let mut targets = vec![FlowTarget {
            id: LOCAL_TARGET.into(),
            label: "This computer".into(),
            kind: "local",
        }];
        targets.extend(remotes.iter().map(|alias| FlowTarget {
            id: target_for_alias(alias),
            label: alias.clone(),
            kind: "ssh",
        }));
        Ok(targets)
    }

    fn open_exchange(&mut self, drive: &DriveBinding) -> Result<MountedExchange, String> {
        self.parts.open_exchange(drive)
    }

    fn open_store(&mut self, _: &DriveBinding) -> Result<Box<dyn FlowStore>, String> {
        Ok(Box::new(FileFlowStore::open(
            self.parts.escrow.directory().to_owned(),
        )?))
    }

    fn adapter(&mut self) -> &mut dyn HostAdapter {
        &mut self.adapter
    }

    fn removal_backend(&mut self, _: &DriveBinding) -> Result<Box<dyn RemovalBackend>, String> {
        Ok(Box::new(NativeRemoval {
            parts: self.parts.clone(),
            adapter: process_adapter(),
        }))
    }

    fn freshness(&self) -> FreshnessPolicy {
        FreshnessPolicy {
            now_seconds: chrono::Utc::now().timestamp(),
            maximum_age_seconds: MAX_OUTBOX_AGE_SECONDS,
            // The drive's capture clock cannot be verified from here.
            capture_clock_trusted: false,
        }
    }

    fn created_at(&self) -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

struct NativeRemoval {
    parts: Parts,
    adapter: ProcessHostAdapter,
}

impl RevocationBackend for NativeRemoval {
    /// This app stores no provider grants: they live with `ais` on the hosts,
    /// which needs a revocation operation in the host protocol first.
    fn inventory(&mut self, _: &DriveBinding) -> Result<Vec<CredentialScope>, String> {
        Ok(Vec::new())
    }
    fn revoke(&mut self, _: &CredentialScope) -> Result<(), String> {
        Err("Credential revocation is not available.".into())
    }
}

impl RemovalBackend for NativeRemoval {
    fn pull_logs(
        &mut self,
        drive: &DriveBinding,
        store: &mut dyn FlowStore,
    ) -> Result<PullLogsResult, String> {
        let receiver = self.parts.receiver(drive)?;
        let exchange = self.parts.open_exchange(drive)?;
        let freshness = FreshnessPolicy {
            now_seconds: chrono::Utc::now().timestamp(),
            maximum_age_seconds: MAX_OUTBOX_AGE_SECONDS,
            capture_clock_trusted: false,
        };
        pull_logs(&exchange, store, &mut self.adapter, &receiver, freshness)
    }

    fn forget_drive(&mut self, drive: &DriveBinding) -> Result<(), String> {
        let mut registry = FileRegistry::open(self.parts.escrow.directory())
            .map_err(|_| "The private drive registry is unavailable.".to_string())?;
        forget_drive_record(
            &mut NativeStore,
            &mut registry,
            self.parts.escrow.clock(),
            drive,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_and_configured_ssh_handles_resolve_and_others_do_not() {
        let remotes = vec!["user@host.example".to_owned()];
        let handle = target_for_alias(&remotes[0]);
        assert!(HostTarget::new(handle.as_str()).is_ok());
        assert_eq!(resolve_source("local", &[]).unwrap(), HostSource::Local);
        assert_eq!(
            resolve_source(&handle, &remotes).unwrap(),
            HostSource::Ssh("user@host.example".into())
        );
        assert!(resolve_source(&handle, &[]).is_err());
        assert!(resolve_source("ssh-zz", &remotes).is_err());
        assert!(resolve_source("ssh-2d6f", &["-o".to_owned()]).is_err());
        assert!(resolve_source("user@host.example", &remotes).is_err());
    }

    #[test]
    fn remotes_are_read_from_the_sync_configuration_and_filtered() {
        let directory =
            std::env::temp_dir().join(format!("ais-flow-remotes-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("sync-v2.json");
        assert!(read_remotes(&path).unwrap().is_empty());
        std::fs::write(
            &path,
            r#"{"version":2,"remotes":["alpha","alpha","-oProxyCommand=x","a b",7,"beta.example"]}"#,
        )
        .unwrap();
        assert_eq!(read_remotes(&path).unwrap(), ["alpha", "beta.example"]);
        std::fs::write(&path, "not json").unwrap();
        assert!(read_remotes(&path).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn drives_resolve_from_the_registry_and_unknown_ones_do_not() {
        let directory =
            std::env::temp_dir().join(format!("ais-flow-drives-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let escrow = EscrowCommandState::new(directory.clone()).unwrap();
        let passphrase = ais_host_core::create::Passphrase::new(
            "SYNTHETIC_FIXTURE_12".into(),
            "SYNTHETIC_FIXTURE_12",
        )
        .unwrap();
        ais_host_core::create::PassphraseSink::hand_over(
            &escrow.sink(),
            &passphrase,
            "synthetic-drive-1",
        )
        .unwrap();
        let mut runtime = NativeFlowRuntime::new(escrow);
        let drive = runtime.resolve_drive("synthetic-drive-1").unwrap();
        assert_eq!(
            (drive.drive_id(), drive.generation()),
            ("synthetic-drive-1", 1)
        );
        assert!(runtime.resolve_drive("synthetic-drive-2").is_err());
        // With no mounted volume the exchange stays closed with a fixed message.
        assert_eq!(
            runtime.open_exchange(&drive).err().unwrap(),
            "The drive's exchange volume is not available."
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
