//! Opt-in, creator-local key retention. Times are Unix seconds, never durations
//! inferred from a refreshed drive. There is deliberately no policy-extension API.
//! Secrets remain native and are never serialised or returned to the webview.

pub mod native;

use crate::registry::{DriveRecord, EscrowState, RegistryData, RegistryStorage, validate_handle};
pub use age::secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EscrowPolicy {
    #[default]
    Disabled,
    Until(u64),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ItemRef(String);

impl ItemRef {
    pub(crate) fn for_drive(installation: &str, drive: &str, generation: u64) -> Self {
        let mut digest = Sha256::new();
        for part in [
            b"ais-host-escrow-v1".as_slice(),
            installation.as_bytes(),
            drive.as_bytes(),
            &generation.to_be_bytes(),
        ] {
            digest.update((part.len() as u64).to_be_bytes());
            digest.update(part);
        }
        Self(crate::release::hex(&digest.finalize()))
    }

    pub(crate) fn account(&self) -> Result<&str, EscrowError> {
        if self.0.len() != 64 || !self.0.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(EscrowError::InvalidRegistry);
        }
        Ok(&self.0)
    }
}

/// Fixed errors only. Native store errors can contain secret bytes or account
/// details and must not become diagnostics, source errors or IPC payloads.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EscrowError {
    #[error("Credential store unavailable; session-only use remains available.")]
    Unavailable,
    #[error("Credential store locked; unlock it or use the passphrase for this session only.")]
    Locked,
    #[error("No retained passphrase is available.")]
    Missing,
    #[error("The retention period has expired. Deletion will be retried if necessary.")]
    Expired,
    #[error("The local clock moved backwards. Correct it before retrieving a retained passphrase.")]
    ClockUntrusted,
    #[error("An explicit future expiry is required when the drive is created.")]
    InvalidRetention,
    #[error("Only this computer's creator record authorises escrow.")]
    NotCreator,
    #[error("The local drive record is invalid.")]
    InvalidRegistry,
    #[error("The local drive registry could not be saved or read.")]
    RegistryUnavailable,
    #[error("Another drive registry operation is in progress.")]
    RegistryBusy,
    #[error("This drive already has a local record.")]
    AlreadyExists,
    #[error("The previous credential still needs deletion.")]
    DeletionPending,
}

/// A cleanup component receives only this capability. Delete must be idempotent
/// for a missing item and must never read its secret as part of deletion.
pub trait EscrowDelete {
    fn delete(&mut self, item: &ItemRef) -> Result<(), EscrowError>;
}

pub trait EscrowStore: EscrowDelete {
    fn put(&mut self, item: &ItemRef, secret: &SecretString) -> Result<(), EscrowError>;
    fn retrieve(&mut self, item: &ItemRef) -> Result<SecretString, EscrowError>;
}

pub trait Clock {
    fn wall_seconds(&self) -> u64;
    fn monotonic_seconds(&self) -> u64;
}

pub struct SystemClock {
    started: Instant,
}
impl Default for SystemClock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}
impl Clock for SystemClock {
    fn wall_seconds(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }
    fn monotonic_seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }
}

/// Keep this guard for the app/cleanup process lifetime, including between
/// registry operations. A monotonic deadline cannot be extended by wall rollback.
pub struct RetentionClock<C: Clock> {
    clock: C,
    wall_start: u64,
    mono_start: u64,
}
impl<C: Clock> RetentionClock<C> {
    pub fn new(clock: C) -> Self {
        let wall_start = clock.wall_seconds();
        let mono_start = clock.monotonic_seconds();
        Self {
            clock,
            wall_start,
            mono_start,
        }
    }

    fn observe(&self, data: &mut RegistryData) -> (u64, bool) {
        let wall = self.clock.wall_seconds();
        let mono = self.clock.monotonic_seconds();
        let suspicious = wall < data.last_observed_at || mono < self.mono_start;
        let effective = wall
            .max(
                self.wall_start
                    .saturating_add(mono.saturating_sub(self.mono_start)),
            )
            .max(data.last_observed_at);
        data.last_observed_at = effective;
        (effective, suspicious)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub deleted: usize,
    pub deletion_pending: usize,
    pub next_expiry: Option<u64>,
    pub clock_untrusted: bool,
}

/// Run at startup, at the nearest expiry, on resume and when the store becomes
/// available. An off computer or locked store cannot promise physical deletion.
/// Interrupted puts are deleted even if their retention has not yet expired.
pub fn purge_expired<D: EscrowDelete, R: RegistryStorage, C: Clock>(
    backend: &mut D,
    repository: &mut R,
    clock: &RetentionClock<C>,
) -> Result<PurgeResult, EscrowError> {
    let mut data = repository.load()?;
    data.validate()?;
    let (now, suspicious) = clock.observe(&mut data);
    let mut result = PurgeResult {
        clock_untrusted: suspicious,
        ..PurgeResult::default()
    };
    for record in data.drives.values_mut() {
        let expired = matches!(record.retention, EscrowPolicy::Until(expiry) if expiry <= now);
        if record.item.is_some()
            && (expired
                || record.escrow_state == EscrowState::PendingWrite
                || record.forget_pending)
        {
            record.escrow_state = EscrowState::DeletionPending;
        }
    }
    repository.save(&data)?;
    let pending: Vec<_> = data
        .drives
        .values()
        .filter(|r| r.escrow_state == EscrowState::DeletionPending)
        .map(|r| (r.drive_id.clone(), r.item.clone()))
        .collect();
    for (id, item) in pending {
        let item = item.ok_or(EscrowError::InvalidRegistry)?;
        if backend.delete(&item).is_err() {
            result.deletion_pending += 1;
            continue;
        }
        let record = data
            .drives
            .get_mut(&id)
            .ok_or(EscrowError::InvalidRegistry)?;
        record.item = None;
        record.escrow_state = EscrowState::Deleted;
        if record.forget_pending {
            data.drives.remove(&id);
        }
        // Save after each deletion so a subsequent failure cannot hide it.
        repository.save(&data)?;
        result.deleted += 1;
    }
    result.next_expiry = data
        .drives
        .values()
        .filter_map(|record| match (record.escrow_state, record.retention) {
            (EscrowState::Active, EscrowPolicy::Until(expiry)) => Some(expiry),
            _ => None,
        })
        .min();
    Ok(result)
}

/// All operations use the repository's exclusive lock. Construct with a
/// short-lived FileRegistry operation, and share the process RetentionClock.
pub struct EscrowService<'a, B, R, C: Clock> {
    backend: &'a mut B,
    repository: &'a mut R,
    clock: &'a RetentionClock<C>,
}

impl<'a, B: EscrowStore, R: RegistryStorage, C: Clock> EscrowService<'a, B, R, C> {
    pub fn new(backend: &'a mut B, repository: &'a mut R, clock: &'a RetentionClock<C>) -> Self {
        Self {
            backend,
            repository,
            clock,
        }
    }

    /// Invoke only after verified successful drive creation. No write happens
    /// during previews. Failed persistence/OS writes leave a deletion tombstone.
    /// The app must obtain consent and register the per-user cleanup component
    /// before offering an Until policy. This library never installs services.
    pub fn create_drive(
        &mut self,
        drive_id: &str,
        policy: EscrowPolicy,
        sources: Vec<String>,
        secret: Option<&SecretString>,
    ) -> Result<DriveRecord, EscrowError> {
        let mut data = self.repository.load()?;
        data.validate()?;
        if data.drives.contains_key(drive_id) {
            return Err(EscrowError::AlreadyExists);
        }
        self.create(&mut data, drive_id, 1, true, policy, sources, secret)
    }

    /// Importing exchange state never authorises storing or fetching a key.
    pub fn import_drive(
        &mut self,
        drive_id: &str,
        generation: u64,
        sources: Vec<String>,
    ) -> Result<DriveRecord, EscrowError> {
        let mut data = self.repository.load()?;
        data.validate()?;
        if data.drives.contains_key(drive_id) {
            return Err(EscrowError::AlreadyExists);
        }
        self.create(
            &mut data,
            drive_id,
            generation,
            false,
            EscrowPolicy::Disabled,
            sources,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create(
        &mut self,
        data: &mut RegistryData,
        id: &str,
        generation: u64,
        created_here: bool,
        policy: EscrowPolicy,
        sources: Vec<String>,
        secret: Option<&SecretString>,
    ) -> Result<DriveRecord, EscrowError> {
        validate_handle(id)?;
        let (now, suspicious) = self.clock.observe(data);
        if suspicious {
            return Err(EscrowError::ClockUntrusted);
        }
        let item = match policy {
            EscrowPolicy::Disabled => None,
            EscrowPolicy::Until(expiry) => {
                if expiry <= now || secret.is_none() {
                    return Err(EscrowError::InvalidRetention);
                }
                Some(ItemRef::for_drive(&data.installation_id, id, generation))
            }
        };
        let record = DriveRecord {
            drive_id: id.into(),
            generation,
            created_at: now,
            retention: policy,
            last_refresh: None,
            created_here,
            escrow_state: if item.is_some() {
                EscrowState::PendingWrite
            } else {
                EscrowState::Disabled
            },
            item: item.clone(),
            forget_pending: false,
            inbox_issued: 0,
            inbox_acknowledged: 0,
            outbox_issued: 0,
            source_references: sources,
            installed_image: None,
            image_update_status: None,
        };
        data.drives.insert(id.into(), record);
        // Journal intent before calling a store that may succeed then return an
        // error. A startup purge can find every potentially durable credential.
        data.validate()?;
        self.repository.save(data)?;
        if let Some(item) = item {
            if let Err(error) = self
                .backend
                .put(&item, secret.ok_or(EscrowError::InvalidRetention)?)
            {
                self.clean_failed_put(data, id, &item);
                return Err(error);
            }
            // The store call may have taken us across the deadline.
            let (now, suspicious) = self.clock.observe(data);
            if suspicious || matches!(policy, EscrowPolicy::Until(expiry) if now >= expiry) {
                self.clean_failed_put(data, id, &item);
                return Err(if suspicious {
                    EscrowError::ClockUntrusted
                } else {
                    EscrowError::Expired
                });
            }
            data.drives
                .get_mut(id)
                .ok_or(EscrowError::InvalidRegistry)?
                .escrow_state = EscrowState::Active;
            if let Err(error) = self.repository.save(data) {
                self.clean_failed_put(data, id, &item);
                return Err(error);
            }
        }
        data.drives
            .get(id)
            .cloned()
            .ok_or(EscrowError::InvalidRegistry)
    }

    fn clean_failed_put(&mut self, data: &mut RegistryData, id: &str, item: &ItemRef) {
        let record = data.drives.get_mut(id).expect("created record");
        record.escrow_state = EscrowState::DeletionPending;
        let _ = self.repository.save(data);
        if self.backend.delete(item).is_ok() {
            let record = data.drives.get_mut(id).expect("created record");
            record.item = None;
            record.escrow_state = EscrowState::Deleted;
            let _ = self.repository.save(data);
        }
    }

    pub fn retrieve(&mut self, id: &str) -> Result<SecretString, EscrowError> {
        let mut data = self.repository.load()?;
        data.validate()?;
        let (now, suspicious) = self.clock.observe(&mut data);
        let record = data.drives.get(id).ok_or(EscrowError::Missing)?;
        if !record.created_here {
            return Err(EscrowError::NotCreator);
        }
        let expiry = match record.retention {
            EscrowPolicy::Disabled => return Err(EscrowError::Missing),
            EscrowPolicy::Until(expiry) => expiry,
        };
        if now >= expiry {
            self.repository.save(&data)?;
            purge_expired(self.backend, self.repository, self.clock)?;
            return Err(EscrowError::Expired);
        }
        if suspicious {
            self.repository.save(&data)?;
            return Err(EscrowError::ClockUntrusted);
        }
        if record.escrow_state != EscrowState::Active || record.forget_pending {
            return Err(EscrowError::Missing);
        }
        let item = record.item.clone().ok_or(EscrowError::InvalidRegistry)?;
        self.repository.save(&data)?;
        let secret = self.backend.retrieve(&item)?;
        let (now, suspicious) = self.clock.observe(&mut data);
        self.repository.save(&data)?;
        if now >= expiry {
            drop(secret);
            purge_expired(self.backend, self.repository, self.clock)?;
            return Err(EscrowError::Expired);
        }
        if suspicious {
            return Err(EscrowError::ClockUntrusted);
        }
        Ok(secret)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), EscrowError> {
        self.remove(id, false)
    }
    pub fn forget(&mut self, id: &str) -> Result<(), EscrowError> {
        self.remove(id, true)
    }

    fn remove(&mut self, id: &str, forget: bool) -> Result<(), EscrowError> {
        let mut data = self.repository.load()?;
        data.validate()?;
        let record = data.drives.get_mut(id).ok_or(EscrowError::Missing)?;
        record.forget_pending |= forget;
        if record.item.is_none() {
            if forget {
                data.drives.remove(id);
            }
            return self.repository.save(&data);
        }
        record.escrow_state = EscrowState::DeletionPending;
        self.repository.save(&data)?;
        purge_expired(self.backend, self.repository, self.clock)?;
        if self
            .repository
            .load()?
            .record(id)
            .is_some_and(|record| record.escrow_state == EscrowState::DeletionPending)
        {
            return Err(EscrowError::DeletionPending);
        }
        Ok(())
    }

    /// Only call after the reset writer has verified destruction. Old generation
    /// deletion must complete before a new key can become active.
    pub fn reset_drive(
        &mut self,
        id: &str,
        policy: EscrowPolicy,
        secret: Option<&SecretString>,
    ) -> Result<DriveRecord, EscrowError> {
        let mut data = self.repository.load()?;
        data.validate()?;
        let previous = data.drives.get(id).cloned().ok_or(EscrowError::Missing)?;
        if !previous.created_here {
            return Err(EscrowError::NotCreator);
        }
        let generation = previous
            .generation
            .checked_add(1)
            .ok_or(EscrowError::InvalidRegistry)?;
        self.delete(id)?;
        data = self.repository.load()?;
        self.create(
            &mut data,
            id,
            generation,
            true,
            policy,
            previous.source_references,
            secret,
        )
    }

    /// Metadata for successful publication; acknowledgement must come from an
    /// authenticated outbox. Publication alone must not advance acknowledgement.
    pub fn record_refresh(
        &mut self,
        id: &str,
        inbox_issued: u64,
        inbox_acknowledged: u64,
        outbox_issued: u64,
    ) -> Result<(), EscrowError> {
        let mut data = self.repository.load()?;
        data.validate()?;
        let (now, suspicious) = self.clock.observe(&mut data);
        if suspicious {
            return Err(EscrowError::ClockUntrusted);
        }
        let record = data.drives.get_mut(id).ok_or(EscrowError::Missing)?;
        if inbox_issued < record.inbox_issued
            || inbox_acknowledged < record.inbox_acknowledged
            || outbox_issued < record.outbox_issued
        {
            return Err(EscrowError::InvalidRegistry);
        }
        record.inbox_issued = inbox_issued;
        record.inbox_acknowledged = inbox_acknowledged;
        record.outbox_issued = outbox_issued;
        record.last_refresh = Some(now);
        data.validate()?;
        self.repository.save(&data)
    }
}
