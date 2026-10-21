//! Machine-local drive records. No passphrase is accepted by this module.
//!
//! Open one repository for an operation, then drop it. Its exclusive lock also
//! serialises the app with the independent expiry process. The app supplies a
//! private local directory resolved through its established ais data paths.

use crate::contract::MAX_SAFE_SEQUENCE;
use crate::escrow::{EscrowError, EscrowPolicy, ItemRef};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EscrowState {
    #[default]
    Disabled,
    PendingWrite,
    Active,
    DeletionPending,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriveRecord {
    pub(crate) drive_id: String,
    pub(crate) generation: u64,
    pub(crate) created_at: u64,
    pub(crate) retention: EscrowPolicy,
    pub(crate) last_refresh: Option<u64>,
    pub(crate) created_here: bool,
    pub(crate) item: Option<ItemRef>,
    pub(crate) escrow_state: EscrowState,
    pub(crate) forget_pending: bool,
    pub(crate) inbox_issued: u64,
    pub(crate) inbox_acknowledged: u64,
    pub(crate) outbox_issued: u64,
    /// Opaque source registry handles, never SSH addresses or credentials.
    pub(crate) source_references: Vec<String>,
    #[serde(default)]
    pub(crate) installed_image: Option<crate::update::InstalledImage>,
    #[serde(default)]
    pub(crate) image_update_status: Option<String>,
}

impl DriveRecord {
    pub fn installed_image(&self) -> Option<&crate::update::InstalledImage> {
        self.installed_image.as_ref()
    }
    pub fn image_update_status(&self) -> Option<&str> {
        self.image_update_status.as_deref()
    }
    pub fn drive_id(&self) -> &str {
        &self.drive_id
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
    pub fn retention(&self) -> EscrowPolicy {
        self.retention
    }
    pub fn last_refresh(&self) -> Option<u64> {
        self.last_refresh
    }
    pub fn created_here(&self) -> bool {
        self.created_here
    }
    pub fn forget_pending(&self) -> bool {
        self.forget_pending
    }
    pub fn item(&self) -> Option<&ItemRef> {
        self.item.as_ref()
    }
    pub fn escrow_state(&self) -> EscrowState {
        self.escrow_state
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
    pub fn source_references(&self) -> &[String] {
        &self.source_references
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryData {
    version: u32,
    pub(crate) installation_id: String,
    pub(crate) last_observed_at: u64,
    pub(crate) drives: BTreeMap<String, DriveRecord>,
}

impl RegistryData {
    pub fn new() -> Result<Self, EscrowError> {
        Ok(Self {
            version: 1,
            installation_id: random_id()?,
            last_observed_at: 0,
            drives: BTreeMap::new(),
        })
    }

    pub fn records(&self) -> impl Iterator<Item = &DriveRecord> {
        self.drives.values()
    }
    pub fn record(&self, id: &str) -> Option<&DriveRecord> {
        self.drives.get(id)
    }

    pub fn record_image(
        &mut self,
        id: &str,
        image: crate::update::InstalledImage,
        status: &str,
    ) -> Result<(), EscrowError> {
        image.validate().map_err(|_| EscrowError::InvalidRegistry)?;
        if !matches!(status, "created" | "updating" | "writtenAwaitingBoot") {
            return Err(EscrowError::InvalidRegistry);
        }
        let record = self
            .drives
            .get_mut(id)
            .ok_or(EscrowError::InvalidRegistry)?;
        if record.forget_pending {
            return Err(EscrowError::InvalidRegistry);
        }
        record.installed_image = Some(image);
        record.image_update_status = Some(status.into());
        Ok(())
    }
    pub fn reserve_update_inbox(&mut self, id: &str, minimum: u64) -> Result<u64, EscrowError> {
        let record = self
            .drives
            .get_mut(id)
            .ok_or(EscrowError::InvalidRegistry)?;
        if record.forget_pending || minimum > MAX_SAFE_SEQUENCE {
            return Err(EscrowError::InvalidRegistry);
        }
        let seq = record
            .inbox_issued
            .max(record.inbox_acknowledged)
            .max(minimum)
            .checked_add(1)
            .filter(|seq| *seq <= MAX_SAFE_SEQUENCE)
            .ok_or(EscrowError::InvalidRegistry)?;
        record.inbox_issued = seq;
        Ok(seq)
    }

    pub fn validate(&self) -> Result<(), EscrowError> {
        if self.version != 1
            || self.installation_id.len() != 64
            || !self.installation_id.bytes().all(|b| b.is_ascii_hexdigit())
            || self.drives.len() > 1024
        {
            return Err(EscrowError::InvalidRegistry);
        }
        for (id, record) in &self.drives {
            validate_handle(id)?;
            if record
                .installed_image
                .as_ref()
                .is_some_and(|image| image.validate().is_err())
                || record.image_update_status.as_deref().is_some_and(|status| {
                    !matches!(status, "created" | "updating" | "writtenAwaitingBoot")
                })
                || id != &record.drive_id
                || record.generation == 0
                || record.created_at > self.last_observed_at
                || record
                    .last_refresh
                    .is_some_and(|n| n < record.created_at || n > self.last_observed_at)
                || record.inbox_issued > MAX_SAFE_SEQUENCE
                || record.outbox_issued > MAX_SAFE_SEQUENCE
                || record.inbox_acknowledged > record.inbox_issued
                || record.source_references.len() > 64
            {
                return Err(EscrowError::InvalidRegistry);
            }
            for source in &record.source_references {
                validate_handle(source)?;
            }
            match record.retention {
                EscrowPolicy::Disabled => {
                    if record.item.is_some() || record.escrow_state != EscrowState::Disabled {
                        return Err(EscrowError::InvalidRegistry);
                    }
                }
                EscrowPolicy::Until(expiry) => {
                    if !record.created_here
                        || expiry <= record.created_at
                        || record.escrow_state == EscrowState::Disabled
                    {
                        return Err(EscrowError::InvalidRegistry);
                    }
                    if record.escrow_state == EscrowState::Deleted {
                        if record.item.is_some() {
                            return Err(EscrowError::InvalidRegistry);
                        }
                    } else if record.item.as_ref()
                        != Some(&ItemRef::for_drive(
                            &self.installation_id,
                            id,
                            record.generation,
                        ))
                    {
                        return Err(EscrowError::InvalidRegistry);
                    }
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn validate_handle(value: &str) -> Result<(), EscrowError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err(EscrowError::InvalidRegistry)
    } else {
        Ok(())
    }
}

pub(crate) fn random_id() -> Result<String, EscrowError> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| EscrowError::Unavailable)?;
    Ok(crate::release::hex(&bytes))
}

/// Implementations must serialise operations and durably replace the complete
/// registry. A save failure must never be treated as permission to return a key.
pub trait RegistryStorage {
    fn load(&mut self) -> Result<RegistryData, EscrowError>;
    fn save(&mut self, data: &RegistryData) -> Result<(), EscrowError>;
}

pub struct FileRegistry {
    directory: PathBuf,
    _lock: File,
}

fn regular_file(path: &Path) -> Result<(), EscrowError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(EscrowError::InvalidRegistry),
    }
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
}

impl FileRegistry {
    pub fn open(directory: &Path) -> Result<Self, EscrowError> {
        // The caller creates the private app directory. Do not follow an
        // exchange-media path or create a second data root implicitly.
        let metadata =
            fs::symlink_metadata(directory).map_err(|_| EscrowError::RegistryUnavailable)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(EscrowError::InvalidRegistry);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(EscrowError::InvalidRegistry);
            }
        }
        let directory =
            fs::canonicalize(directory).map_err(|_| EscrowError::RegistryUnavailable)?;
        let lock_path = directory.join("escrow.lock");
        regular_file(&lock_path)?;
        let lock = private_options()
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| EscrowError::RegistryUnavailable)?;
        // A child forked by another thread keeps the lock until its exec, so a
        // brief wait avoids reporting a spurious "in progress" error.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while fs2::FileExt::try_lock_exclusive(&lock).is_err() {
            if std::time::Instant::now() >= deadline {
                return Err(EscrowError::RegistryBusy);
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(Self {
            directory,
            _lock: lock,
        })
    }
}

impl RegistryStorage for FileRegistry {
    fn load(&mut self) -> Result<RegistryData, EscrowError> {
        let path = self.directory.join("drives.json");
        regular_file(&path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = match options.open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let data = RegistryData::new()?;
                self.save(&data)?;
                return Ok(data);
            }
            Err(_) => return Err(EscrowError::RegistryUnavailable),
        };
        let mut bytes = Vec::new();
        file.take(MAX_REGISTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| EscrowError::RegistryUnavailable)?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err(EscrowError::InvalidRegistry);
        }
        let data: RegistryData =
            serde_json::from_slice(&bytes).map_err(|_| EscrowError::InvalidRegistry)?;
        data.validate()?;
        Ok(data)
    }

    fn save(&mut self, data: &RegistryData) -> Result<(), EscrowError> {
        data.validate()?;
        let bytes = serde_json::to_vec(data).map_err(|_| EscrowError::InvalidRegistry)?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err(EscrowError::InvalidRegistry);
        }
        let destination = self.directory.join("drives.json");
        regular_file(&destination)?;
        let temporary = self
            .directory
            .join(format!("drives-{}.pending", random_id()?));
        let mut file = private_options()
            .create_new(true)
            .open(&temporary)
            .map_err(|_| EscrowError::RegistryUnavailable)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| EscrowError::RegistryUnavailable)?;
        drop(file);
        fs::rename(temporary, destination).map_err(|_| EscrowError::RegistryUnavailable)?;
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| EscrowError::RegistryUnavailable)?;
        Ok(())
    }
}
