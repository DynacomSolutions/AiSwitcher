//! Authenticated recovery intent, accessed only through a verified exchange
//! directory. The helper still independently verifies every image and write.
use crate::{
    drive_identity::DriveIdentity,
    exchange_root::ExchangeRoot,
    release::{VerifiedImage, hex, valid_live_tag},
    update::{DriveSnapshot, InstalledImage, hardware_hint},
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const JOURNAL_NAME: &str = ".ais-image-update.age";
const MAX_BYTES: u64 = 16 * 1024;
const INVALID: &str = "The update journal is invalid or was altered. No image was written.";
const AUTHENTICATION: &str = "The update journal could not be authenticated. Check the passphrase; an altered journal is refused.";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateJournal {
    version: u32,
    target_tag: String,
    image_sha256: [u8; 32],
    release_order: (u64, u64),
    /// Partition numbers in write order: base, BIOS, then the personalised ESP.
    partitions: [u8; 3],
    drive_identity: DriveIdentity,
    /// Retain the starting release so recovery also works after the registry
    /// was advanced but journal removal was interrupted.
    previous: InstalledImage,
}

impl UpdateJournal {
    pub fn new(image: &VerifiedImage, previous: InstalledImage) -> Result<Self, String> {
        previous
            .require_newer(image)
            .map_err(|error| error.to_string())?;
        let journal = Self {
            version: 1,
            target_tag: image.selection().tag().into(),
            image_sha256: image.digest(),
            release_order: image.selection().order(),
            partitions: [3, 1, 2],
            drive_identity: previous.identity.clone(),
            previous,
        };
        journal.validate()?;
        Ok(journal)
    }

    fn validate(&self) -> Result<(), String> {
        self.previous.validate().map_err(|_| INVALID)?;
        if self.version != 1
            || self.partitions != [3, 1, 2]
            || self.drive_identity != self.previous.identity
            || !valid_live_tag(&self.target_tag)
            || self.release_order <= self.previous.release_order
            || self.target_tag == self.previous.tag
            || self.image_sha256 == self.previous.image_digest
        {
            return Err(INVALID.into());
        }
        Ok(())
    }

    pub fn tag(&self) -> &str {
        &self.target_tag
    }
    pub fn image_digest(&self) -> [u8; 32] {
        self.image_sha256
    }
    pub fn previous(&self) -> &InstalledImage {
        &self.previous
    }

    pub fn check_drive(
        &self,
        snapshot: &DriveSnapshot,
        registered: &InstalledImage,
    ) -> Result<(), String> {
        self.validate()?;
        let completed = registered.identity == self.drive_identity
            && registered.hardware_hint == self.previous.hardware_hint
            && registered.tag == self.target_tag
            && registered.image_digest == self.image_sha256
            && registered.release_order == self.release_order;
        if snapshot.partitions(&self.drive_identity).is_err()
            || hardware_hint(&snapshot.observation) != self.previous.hardware_hint
            || (registered != &self.previous && !completed)
        {
            return Err(
                "The update journal does not match this drive's disk and partition identities. No image was written."
                    .into(),
            );
        }
        Ok(())
    }

    pub fn check_image(&self, image: &VerifiedImage) -> Result<(), String> {
        self.validate()?;
        if image.selection().tag() != self.target_tag
            || image.digest() != self.image_sha256
            || image.selection().order() != self.release_order
        {
            return Err("The verified release does not match the update journal's tag and SHA-256. No image was written.".into());
        }
        Ok(())
    }
}

/// Retained ciphertext also binds confirmation to the exact journal inspected
/// during preview. Loading it alone never authorises a write.
#[derive(Clone, Eq, PartialEq)]
pub struct SealedJournal(Vec<u8>);

impl SealedJournal {
    pub fn load(root: &ExchangeRoot) -> Result<Option<Self>, String> {
        let Some(file) = root.optional_file(JOURNAL_NAME)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "The update journal could not be read.")?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
            return Err(INVALID.into());
        }
        Ok(Some(Self(bytes)))
    }

    pub fn authenticate(&self, passphrase: &str) -> Result<UpdateJournal, String> {
        let decryptor = age::Decryptor::new(self.0.as_slice()).map_err(|_| AUTHENTICATION)?;
        if !decryptor.is_scrypt() {
            return Err(AUTHENTICATION.into());
        }
        let mut identity =
            age::scrypt::Identity::new(age::secrecy::SecretString::from(passphrase.to_owned()));
        identity.set_max_work_factor(20);
        let reader = decryptor
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .map_err(|_| AUTHENTICATION)?;
        let mut bytes = Vec::new();
        reader
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| AUTHENTICATION)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(INVALID.into());
        }
        let journal: UpdateJournal = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
        journal.validate()?;
        Ok(journal)
    }

    /// Flush the complete authenticated file, publish without replacing an
    /// existing journal, then flush the retained directory before any raw write.
    pub fn publish(
        root: &ExchangeRoot,
        journal: &UpdateJournal,
        passphrase: &str,
    ) -> Result<Self, String> {
        journal.validate()?;
        let payload = serde_json::to_vec(journal).map_err(|_| INVALID)?;
        let encryptor = age::Encryptor::with_user_passphrase(age::secrecy::SecretString::from(
            passphrase.to_owned(),
        ));
        let mut ciphertext = Vec::new();
        let mut writer = encryptor
            .wrap_output(&mut ciphertext)
            .map_err(|_| "The update journal could not be encrypted.")?;
        writer
            .write_all(&payload)
            .map_err(|_| "The update journal could not be encrypted.")?;
        writer
            .finish()
            .map_err(|_| "The update journal could not be encrypted.")?;
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| "Cannot create a journal staging name.")?;
        let staging = format!(".ais-image-update-{}.tmp", hex(&nonce));
        let mut file = root.open_file(&staging, true)?;
        let result = (|| {
            file.write_all(&ciphertext)
                .and_then(|()| file.sync_all())
                .map_err(|_| "The update journal could not be flushed.")?;
            root.rename(&staging, JOURNAL_NAME)
        })();
        if result.is_err() {
            root.remove(&staging);
            let _ = root.sync();
        }
        result?;
        let sealed = Self(ciphertext);
        sealed.check_current(root)?;
        Ok(sealed)
    }

    pub fn check_current(&self, root: &ExchangeRoot) -> Result<(), String> {
        if Self::load(root)?.as_ref() != Some(self) {
            return Err(
                "The update journal changed or disappeared. Preview the drive again.".into(),
            );
        }
        Ok(())
    }

    /// Call only after the verified writer has read back every partition.
    pub fn finish(&self, root: &ExchangeRoot) -> Result<(), String> {
        self.check_current(root)?;
        root.remove_file(JOURNAL_NAME)?;
        root.sync()
    }
}
