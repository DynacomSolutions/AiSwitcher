//! Durable, secret-free flow state. Keep the store open across a whole operation:
//! its cross-process lock serialises reservations, import receipts and journals.

use crate::{
    bundle::{BundleOperationLock, acquire_bundle_operation_lock},
    contract::{MAX_BUNDLE_ENTRIES, MAX_SAFE_SEQUENCE, classify_path},
    exchange::{check_directory, open_regular, read_regular},
    registry::{DriveRecord, FileRegistry, RegistryStorage, validate_handle},
    remove::RemoveJournal,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::PathBuf,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriveBinding {
    drive_id: String,
    generation: u64,
}

impl DriveBinding {
    pub fn new(drive_id: impl Into<String>, generation: u64) -> Result<Self, String> {
        let binding = Self {
            drive_id: drive_id.into(),
            generation,
        };
        binding.validate()?;
        Ok(binding)
    }
    pub fn from_record(record: &DriveRecord) -> Result<Self, String> {
        Self::new(record.drive_id(), record.generation())
    }
    pub fn drive_id(&self) -> &str {
        &self.drive_id
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_handle(&self.drive_id).map_err(|_| "invalid drive handle")?;
        if self.generation == 0 || self.generation > MAX_SAFE_SEQUENCE {
            return Err("invalid drive generation".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingRefresh {
    pub sequence: u64,
    pub source_digest: String,
    pub selection_digest: String,
    pub proposed_hashes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutboxSeen {
    pub sequence: u64,
    pub digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowState {
    version: u8,
    pub(crate) binding: DriveBinding,
    pub(crate) inbox_issued: u64,
    pub(crate) inbox_acknowledged: u64,
    pub(crate) outbox_issued: u64,
    pub(crate) pending: Option<PendingRefresh>,
    pub(crate) common_hashes: BTreeMap<String, String>,
    pub(crate) last_outbox: Option<OutboxSeen>,
    pub(crate) log_receipts: BTreeSet<String>,
    pub(crate) removal: Option<RemoveJournal>,
}

impl FlowState {
    pub fn new(binding: DriveBinding) -> Self {
        Self {
            version: 1,
            binding,
            inbox_issued: 0,
            inbox_acknowledged: 0,
            outbox_issued: 0,
            pending: None,
            common_hashes: BTreeMap::new(),
            last_outbox: None,
            log_receipts: BTreeSet::new(),
            removal: None,
        }
    }
    pub fn from_record(record: &DriveRecord) -> Result<Self, String> {
        let mut state = Self::new(DriveBinding::from_record(record)?);
        state.inbox_issued = record.inbox_issued();
        state.inbox_acknowledged = record.inbox_acknowledged();
        state.outbox_issued = record.outbox_issued();
        Ok(state)
    }
    pub fn binding(&self) -> &DriveBinding {
        &self.binding
    }
    pub fn inbox_issued(&self) -> u64 {
        self.inbox_issued
    }
    pub fn inbox_acknowledged(&self) -> u64 {
        self.inbox_acknowledged
    }
    pub fn outbox_issued(&self) -> u64 {
        self.outbox_issued
    }
    pub fn common_hashes(&self) -> &BTreeMap<String, String> {
        &self.common_hashes
    }
    pub fn removal(&self) -> Option<&RemoveJournal> {
        self.removal.as_ref()
    }
    pub fn receipt_count(&self) -> usize {
        self.log_receipts.len()
    }

    pub fn validate(&self, binding: &DriveBinding) -> Result<(), String> {
        self.binding.validate()?;
        if self.version != 1
            || &self.binding != binding
            || self.inbox_issued > MAX_SAFE_SEQUENCE
            || self.outbox_issued > MAX_SAFE_SEQUENCE
            || self.inbox_acknowledged > self.inbox_issued
        {
            return Err("flow state does not match this drive generation".into());
        }
        validate_hashes(&self.common_hashes)?;
        if let Some(pending) = &self.pending {
            if pending.sequence == 0
                || pending.sequence > self.inbox_issued
                || !valid_hash(&pending.source_digest)
                || !valid_hash(&pending.selection_digest)
            {
                return Err("invalid pending refresh state".into());
            }
            validate_hashes(&pending.proposed_hashes)?;
        }
        if self.last_outbox.as_ref().is_some_and(|seen| {
            seen.sequence == 0 || seen.sequence > self.outbox_issued || !valid_hash(&seen.digest)
        }) || self.log_receipts.len() > 1024
            || self.log_receipts.iter().any(|r| !valid_hash(r))
        {
            return Err("invalid outbox receipt state".into());
        }
        if let Some(removal) = &self.removal {
            removal.validate(binding)?;
        }
        Ok(())
    }
}

fn validate_hashes(hashes: &BTreeMap<String, String>) -> Result<(), String> {
    if hashes.len() > MAX_BUNDLE_ENTRIES
        || hashes.iter().any(|(path, hash)| {
            !valid_hash(hash) || !classify_path(path).is_some_and(|class| class.is_config())
        })
    {
        Err("invalid common configuration hashes".into())
    } else {
        Ok(())
    }
}
pub(crate) fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Implementations must retain an exclusive operation lock and make save atomic
/// and durable. Failed saves must not be reported as success.
pub trait FlowStore {
    fn load(&mut self, binding: &DriveBinding) -> Result<FlowState, String>;
    fn save(&mut self, state: &FlowState) -> Result<(), String>;
}

pub struct FileFlowStore {
    registry_directory: PathBuf,
    directory: PathBuf,
    _lock: BundleOperationLock,
}

impl FileFlowStore {
    pub fn open(native_registry_directory: PathBuf) -> Result<Self, String> {
        // Reuse existing private-directory ownership/permission checks. Drop
        // its registry lock before taking the independent flow lock.
        drop(
            FileRegistry::open(&native_registry_directory)
                .map_err(|_| "private drive registry is unavailable")?,
        );
        let directory = native_registry_directory.join("flows");
        if !directory.exists() {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&directory)
                .map_err(|_| "cannot create private flow directory")?;
        }
        check_directory(&directory)?;
        // Also reject an existing flow directory with unsafe permissions.
        drop(FileRegistry::open(&directory).map_err(|_| "flow directory is not private")?);
        let lock = acquire_bundle_operation_lock(&directory)
            .map_err(|_| "another flow operation is running")?;
        Ok(Self {
            registry_directory: native_registry_directory,
            directory,
            _lock: lock,
        })
    }

    fn path(&self, binding: &DriveBinding) -> Result<PathBuf, String> {
        binding.validate()?;
        Ok(self.directory.join(format!(
            "{}-{}.json",
            binding.drive_id(),
            binding.generation()
        )))
    }

    /// Resolve retained removal journals after their drive records have been
    /// forgotten. Native discovery can expose these as journal-only handles,
    /// preserving failure review and retries across application restarts.
    pub fn retained_removal_bindings(&mut self) -> Result<Vec<DriveBinding>, String> {
        let mut bindings = Vec::new();
        for (count, entry) in fs::read_dir(&self.directory)
            .map_err(|_| "cannot list removal journals")?
            .enumerate()
        {
            if count >= 4096 {
                return Err("too many retained flow files".into());
            }
            let path = entry.map_err(|_| "cannot inspect removal journal")?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let state: FlowState = serde_json::from_slice(&read_regular(&path, 32 * 1024 * 1024)?)
                .map_err(|_| "invalid retained flow state")?;
            state.validate(&state.binding)?;
            if path != self.path(&state.binding)? {
                return Err("retained flow file does not match its drive generation".into());
            }
            if state.removal.is_some() {
                bindings.push(state.binding);
            }
        }
        bindings.sort_by(|left, right| {
            left.drive_id()
                .cmp(right.drive_id())
                .then(left.generation().cmp(&right.generation()))
        });
        Ok(bindings)
    }
}

impl FlowStore for FileFlowStore {
    fn load(&mut self, binding: &DriveBinding) -> Result<FlowState, String> {
        let path = self.path(binding)?;
        let state = match fs::symlink_metadata(&path) {
            Ok(_) => serde_json::from_slice(&read_regular(&path, 32 * 1024 * 1024)?)
                .map_err(|_| "invalid flow state file")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut registry = FileRegistry::open(&self.registry_directory)
                    .map_err(|_| "drive registry is unavailable")?;
                let records = registry.load().map_err(|_| "cannot read drive registry")?;
                let record = records
                    .record(binding.drive_id())
                    .ok_or("drive record is missing; import authenticated drive state first")?;
                FlowState::from_record(record)?
            }
            Err(_) => return Err("cannot inspect flow state".into()),
        };
        state.validate(binding)?;
        Ok(state)
    }

    fn save(&mut self, state: &FlowState) -> Result<(), String> {
        state.validate(&state.binding)?;
        let bytes = serde_json::to_vec(state).map_err(|_| "cannot serialise flow state")?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("flow state exceeds its size limit".into());
        }
        let target = self.path(&state.binding)?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "cannot reserve flow state file")?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let temporary = self.directory.join(format!(".pending-{suffix}"));
        let mut file = open_regular(&temporary, true)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "cannot persist flow state")?;
        drop(file);
        fs::rename(&temporary, &target).map_err(|_| "cannot publish flow state")?;
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| "cannot flush flow state directory")?;
        Ok(())
    }
}
