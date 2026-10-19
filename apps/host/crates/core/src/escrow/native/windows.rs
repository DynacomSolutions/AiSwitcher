use super::{EscrowError, MAX_SECRET_BYTES, SERVICE, SecretString, decode};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_SUCH_LOGON_SESSION, ERROR_NOT_FOUND, GetLastError},
    Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    },
};
use zeroize::Zeroize;

fn target(account: &str) -> Vec<u16> {
    format!("{SERVICE}/{account}")
        .encode_utf16()
        .chain(Some(0))
        .collect()
}
fn last_error() -> EscrowError {
    match unsafe { GetLastError() } {
        ERROR_NOT_FOUND => EscrowError::Missing,
        ERROR_NO_SUCH_LOGON_SESSION => EscrowError::Locked,
        _ => EscrowError::Unavailable,
    }
}
pub(super) fn availability() -> Result<(), EscrowError> {
    Ok(())
}

pub(super) fn put(account: &str, bytes: &[u8]) -> Result<(), EscrowError> {
    let mut target = target(account);
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_ptr().cast_mut(),
        // Never enterprise persistence, which permits credential roaming.
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..CREDENTIALW::default()
    };
    // Native API copies the blob before returning and does not mutate it.
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

struct Allocation(*mut CREDENTIALW);
impl Drop for Allocation {
    fn drop(&mut self) {
        // CredReadW owns this allocation; zero its blob before releasing it.
        unsafe {
            let value = &*self.0;
            if !value.CredentialBlob.is_null()
                && value.CredentialBlobSize as usize <= MAX_SECRET_BYTES
            {
                std::slice::from_raw_parts_mut(
                    value.CredentialBlob,
                    value.CredentialBlobSize as usize,
                )
                .zeroize();
            }
            CredFree(self.0.cast());
        }
    }
}

pub(super) fn retrieve(account: &str) -> Result<SecretString, EscrowError> {
    let target = target(account);
    let mut raw = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
        return Err(last_error());
    }
    if raw.is_null() {
        return Err(EscrowError::Unavailable);
    }
    let owned = Allocation(raw);
    let credential = unsafe { &*owned.0 };
    let length = credential.CredentialBlobSize as usize;
    if credential.CredentialBlob.is_null() || length > MAX_SECRET_BYTES {
        return Err(EscrowError::Unavailable);
    }
    decode(unsafe { std::slice::from_raw_parts(credential.CredentialBlob, length) }.to_vec())
}

pub(super) fn delete(account: &str) -> Result<(), EscrowError> {
    let target = target(account);
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
        return Ok(());
    }
    match last_error() {
        EscrowError::Missing => Ok(()),
        other => Err(other),
    }
}
