//! Native per-user stores. No file or environment fallback is permitted.
//! The delete-only handle never fetches a credential to delete it.

use super::{EscrowDelete, EscrowError, EscrowStore, ExposeSecret, ItemRef, SecretString};
use zeroize::Zeroizing;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as platform;

const SERVICE: &str = "ais-host-escrow";
// Small enough for all three native stores, including Credential Manager.
const MAX_SECRET_BYTES: usize = 2560;

fn decode(bytes: Vec<u8>) -> Result<SecretString, EscrowError> {
    let bytes = Zeroizing::new(bytes);
    if bytes.len() > MAX_SECRET_BYTES {
        return Err(EscrowError::Unavailable);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| EscrowError::Unavailable)?;
    Ok(SecretString::from(text))
}

#[derive(Default)]
pub struct NativeStore;
#[derive(Default)]
pub struct NativeDeleter;

impl NativeStore {
    /// Linux checks the unlocked default collection without prompting or
    /// creating it. Other platforms are checked by the actual operation.
    pub fn availability(&self) -> Result<(), EscrowError> {
        platform::availability()
    }
}

impl EscrowDelete for NativeDeleter {
    fn delete(&mut self, item: &ItemRef) -> Result<(), EscrowError> {
        platform::delete(item.account()?)
    }
}
impl EscrowDelete for NativeStore {
    fn delete(&mut self, item: &ItemRef) -> Result<(), EscrowError> {
        NativeDeleter.delete(item)
    }
}
impl EscrowStore for NativeStore {
    fn put(&mut self, item: &ItemRef, secret: &SecretString) -> Result<(), EscrowError> {
        let bytes = secret.expose_secret().as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_SECRET_BYTES {
            return Err(EscrowError::InvalidRetention);
        }
        platform::put(item.account()?, bytes)
    }
    fn retrieve(&mut self, item: &ItemRef) -> Result<SecretString, EscrowError> {
        platform::retrieve(item.account()?)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn availability() -> Result<(), EscrowError> {
        Err(EscrowError::Unavailable)
    }
    pub fn put(_: &str, _: &[u8]) -> Result<(), EscrowError> {
        Err(EscrowError::Unavailable)
    }
    pub fn retrieve(_: &str) -> Result<SecretString, EscrowError> {
        Err(EscrowError::Unavailable)
    }
    pub fn delete(_: &str) -> Result<(), EscrowError> {
        Err(EscrowError::Unavailable)
    }
}
