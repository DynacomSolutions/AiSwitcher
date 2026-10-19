//! Create-drive options and their pre-destructive validation. Nothing here
//! touches a device; it decides whether a request may reach confirmation.
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Space that must remain for the encrypted persist partition after the image
/// and any selected model. The agreed reserve is a product decision; this is
/// the conservative value used until it is changed in one place.
pub const PERSIST_RESERVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MIN_PASSPHRASE_CHARS: usize = 12;
pub const MAX_PASSPHRASE_BYTES: usize = 1024;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum CreateError {
    #[error("The passphrase must be at least 12 characters.")]
    PassphraseShort,
    #[error("The passphrase is too long.")]
    PassphraseLong,
    #[error("The passphrase and its confirmation differ.")]
    PassphraseMismatch,
    #[error("The selected model is not in the pinned catalogue.")]
    UnknownModel,
    #[error("The model licence was not accepted.")]
    LicenceNotAccepted,
    #[error("The drive is too small for the image, the model and the persist reserve.")]
    UndersizedDisk,
}

/// A passphrase that cannot be printed or serialised by accident.
pub struct Passphrase(String);

impl Passphrase {
    pub fn new(value: String, confirmation: &str) -> Result<Self, CreateError> {
        if value.len() > MAX_PASSPHRASE_BYTES {
            return Err(CreateError::PassphraseLong);
        }
        if value.chars().count() < MIN_PASSPHRASE_CHARS {
            return Err(CreateError::PassphraseShort);
        }
        if value != confirmation {
            return Err(CreateError::PassphraseMismatch);
        }
        Ok(Self(value))
    }

    /// For the encrypted-inbox builder only.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Passphrase {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Passphrase(redacted)")
    }
}

impl Drop for Passphrase {
    fn drop(&mut self) {
        // Best effort: overwrite in place before the allocation is released.
        // shortcut: not guaranteed against copies, replace with a zeroizing type when escrow lands.
        // SAFETY: writing zero bytes keeps the string valid UTF-8.
        unsafe { self.0.as_bytes_mut().fill(0) };
    }
}

/// One entry of the reviewed model catalogue. The pin is immutable: a download
/// is accepted only when its revision and SHA-256 match exactly.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub quality: String,
    pub size_bytes: u64,
    pub licence_name: String,
    pub licence_text: String,
    pub revision: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Catalogue {
    pub models: Vec<ModelEntry>,
}

impl Catalogue {
    pub fn parse(json: &str) -> Result<Self, CreateError> {
        let catalogue: Self = serde_json::from_str(json).map_err(|_| CreateError::UnknownModel)?;
        let pinned = |entry: &ModelEntry| {
            entry.sha256.len() == 64
                && entry
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                && !entry.revision.is_empty()
                && entry.size_bytes > 0
                && !entry.licence_text.is_empty()
        };
        if catalogue.models.iter().all(pinned) {
            Ok(catalogue)
        } else {
            Err(CreateError::UnknownModel)
        }
    }

    pub fn get(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|entry| entry.id == id)
    }
}

/// The reviewed catalogue shipped with the app. It is empty until real,
/// verified pins exist, so no model can be offered or downloaded.
pub const BUNDLED_CATALOGUE: &str = include_str!("model-catalogue.json");

#[derive(Debug)]
pub struct CreateOptions {
    /// `None` is an explicit "no model": no model request and no manifest entry.
    pub model_id: Option<String>,
    pub licence_accepted: bool,
}

/// Bytes that must fit on the target for this request, or an error that stops
/// the flow before any confirmation.
pub fn check_capacity(
    options: &CreateOptions,
    catalogue: &Catalogue,
    image_bytes: u64,
    capacity_bytes: u64,
) -> Result<Option<ModelEntry>, CreateError> {
    let model = match options.model_id.as_deref() {
        None => None,
        Some(id) => {
            let entry = catalogue.get(id).ok_or(CreateError::UnknownModel)?;
            if !options.licence_accepted {
                return Err(CreateError::LicenceNotAccepted);
            }
            Some(entry.clone())
        }
    };
    let needed = image_bytes
        .checked_add(model.as_ref().map_or(0, |entry| entry.size_bytes))
        .and_then(|sum| sum.checked_add(PERSIST_RESERVE_BYTES))
        .ok_or(CreateError::UndersizedDisk)?;
    if capacity_bytes < needed {
        return Err(CreateError::UndersizedDisk);
    }
    Ok(model)
}

/// The single hand-off point between the create flow and key escrow. Task 5
/// provides the retaining implementation; creation never persists the
/// passphrase itself.
pub trait PassphraseSink {
    /// Called once, after the drive is written and verified. `drive_id` is the
    /// physical identity used for the local drive record.
    fn hand_over(&self, passphrase: &Passphrase, drive_id: &str) -> Result<(), String>;
}

/// Session-only use: the passphrase is dropped after the flow and never stored.
pub struct SessionOnly;

impl PassphraseSink for SessionOnly {
    fn hand_over(&self, _passphrase: &Passphrase, _drive_id: &str) -> Result<(), String> {
        Ok(())
    }
}
