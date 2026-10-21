use super::{EscrowError, SERVICE, SecretString, decode};
use security_framework::passwords::{
    PasswordOptions, delete_generic_password_options, generic_password,
    set_generic_password_options,
};

fn map(error: security_framework::base::Error) -> EscrowError {
    // Security framework OSStatus values. Do not expose native error text.
    match error.code() {
        -25300 => EscrowError::Missing,         // errSecItemNotFound
        -25308 | -25293 => EscrowError::Locked, // interaction/authentication
        _ => EscrowError::Unavailable,
    }
}

fn options(account: &str) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(SERVICE, account);
    options.set_access_synchronized(Some(false));
    // The login keychain: the data-protection keychain and access-control flags
    // need an entitlement a Developer ID app without a provisioning profile
    // cannot hold.
    options
}

pub(super) fn availability() -> Result<(), EscrowError> {
    // Probe with a delete, which reads no data.
    delete("availability-probe")
}

pub(super) fn put(account: &str, bytes: &[u8]) -> Result<(), EscrowError> {
    set_generic_password_options(bytes, options(account)).map_err(map)
}

pub(super) fn retrieve(account: &str) -> Result<SecretString, EscrowError> {
    decode(generic_password(options(account)).map_err(map)?)
}

pub(super) fn delete(account: &str) -> Result<(), EscrowError> {
    // SecItemDelete directly, never find_generic_password (which reads data).
    match delete_generic_password_options(options(account)).map_err(map) {
        Err(EscrowError::Missing) | Ok(()) => Ok(()),
        other => other,
    }
}
