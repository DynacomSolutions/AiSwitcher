use super::{EscrowError, SERVICE, SecretString, decode};
use dbus_secret_service::{EncryptionType, Error, SecretService};
use std::collections::HashMap;

fn map(error: Error) -> EscrowError {
    match error {
        Error::Locked | Error::Prompt => EscrowError::Locked,
        Error::NoResult => EscrowError::Missing,
        _ => EscrowError::Unavailable,
    }
}

fn connect() -> Result<SecretService, EscrowError> {
    // Encrypted D-Bus session; never prompt from the expiry component.
    SecretService::connect_with_max_prompt_timeout(EncryptionType::Dh, 0).map_err(map)
}

fn attributes(account: &str) -> HashMap<&str, &str> {
    HashMap::from([("application", SERVICE), ("drive-generation", account)])
}

pub(super) fn availability() -> Result<(), EscrowError> {
    let service = connect()?;
    let collection = service
        .get_default_collection()
        .map_err(|_| EscrowError::Unavailable)?;
    if collection.is_locked().map_err(map)? {
        return Err(EscrowError::Locked);
    }
    Ok(())
}

pub(super) fn put(account: &str, bytes: &[u8]) -> Result<(), EscrowError> {
    let service = connect()?;
    let collection = service
        .get_default_collection()
        .map_err(|_| EscrowError::Unavailable)?;
    if collection.is_locked().map_err(map)? {
        return Err(EscrowError::Locked);
    }
    // Secret Service has no portable cloud-sync or per-application ACL flag.
    // The user's default collection supplies its access policy. Never unlock
    // it, use a plaintext file fallback, or send the secret to a remote source.
    collection
        .create_item(
            "AIS retained drive passphrase",
            attributes(account),
            bytes,
            true,
            "text/plain",
        )
        .map_err(map)?;
    Ok(())
}

pub(super) fn retrieve(account: &str) -> Result<SecretString, EscrowError> {
    let service = connect()?;
    let found = service.search_items(attributes(account)).map_err(map)?;
    if !found.locked.is_empty() {
        return Err(EscrowError::Locked);
    }
    if found.unlocked.len() > 1 {
        return Err(EscrowError::Unavailable);
    }
    let item = found.unlocked.first().ok_or(EscrowError::Missing)?;
    decode(item.get_secret().map_err(map)?)
}

pub(super) fn delete(account: &str) -> Result<(), EscrowError> {
    let service = connect()?;
    let found = service.search_items(attributes(account)).map_err(map)?;
    // Delete every owned duplicate without retrieving any of its data.
    for item in found.unlocked {
        item.delete().map_err(map)?;
    }
    if !found.locked.is_empty() {
        return Err(EscrowError::Locked);
    }
    Ok(())
}
