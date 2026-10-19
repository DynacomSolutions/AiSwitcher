//! Read signed entitlements for this process. The pinned Security wrapper has
//! no SecTask API; this narrow bridge uses only public Security/CoreFoundation
//! APIs and returns bounded non-secret strings. It never shells out.
use super::EscrowError;
use std::{
    ffi::{CStr, c_char, c_void},
    ptr,
};

type CfRef = *const c_void;
const UTF8: u32 = 0x0800_0100;

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecTaskCreateFromSelf(allocator: CfRef) -> CfRef;
    fn SecTaskCopyValueForEntitlement(task: CfRef, entitlement: CfRef, error: *mut CfRef) -> CfRef;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: CfRef);
    fn CFGetTypeID(value: CfRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithBytes(
        allocator: CfRef,
        bytes: *const u8,
        count: isize,
        encoding: u32,
        external: u8,
    ) -> CfRef;
    fn CFStringGetCString(value: CfRef, buffer: *mut c_char, capacity: isize, encoding: u32) -> u8;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(value: CfRef) -> isize;
    fn CFArrayGetValueAtIndex(value: CfRef, index: isize) -> CfRef;
}

struct Owned(CfRef);
impl Owned {
    /// Only pass a non-borrowed Create/Copy result.
    fn from_created(value: CfRef) -> Result<Self, EscrowError> {
        if value.is_null() {
            Err(EscrowError::Unavailable)
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: from_created owns one non-null Create/Copy reference.
        unsafe { CFRelease(self.0) }
    }
}

fn entitlement(task: &Owned, name: &str) -> Result<Owned, EscrowError> {
    // SAFETY: Rust bytes remain alive for the call; CF copies them. The caller
    // owns a live SecTask. A null error pointer suppresses native diagnostics.
    unsafe {
        let key = Owned::from_created(CFStringCreateWithBytes(
            ptr::null(),
            name.as_ptr(),
            name.len() as isize,
            UTF8,
            0,
        ))?;
        Owned::from_created(SecTaskCopyValueForEntitlement(
            task.0,
            key.0,
            ptr::null_mut(),
        ))
    }
}

/// The reference is borrowed from a live owned CF object and type checked here.
unsafe fn string(value: CfRef) -> Result<String, EscrowError> {
    // SAFETY: caller keeps the owning string/array alive throughout this call.
    unsafe {
        if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
            return Err(EscrowError::Unavailable);
        }
        let mut buffer = [0 as c_char; 512];
        if CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) == 0 {
            return Err(EscrowError::Unavailable);
        }
        CStr::from_ptr(buffer.as_ptr())
            .to_str()
            .map(str::to_owned)
            .map_err(|_| EscrowError::Unavailable)
    }
}

pub(super) fn current() -> Result<(String, Vec<String>), EscrowError> {
    // SAFETY: null selects the default allocator; owned references outlive all
    // their borrowed values. Array contents are checked before string access.
    unsafe {
        let task = Owned::from_created(SecTaskCreateFromSelf(ptr::null()))?;
        let team = entitlement(&task, "com.apple.developer.team-identifier")?;
        let groups = entitlement(&task, "keychain-access-groups")?;
        if CFGetTypeID(groups.0) != CFArrayGetTypeID() {
            return Err(EscrowError::Unavailable);
        }
        let count = CFArrayGetCount(groups.0);
        if !(1..=64).contains(&count) {
            return Err(EscrowError::Unavailable);
        }
        let groups = (0..count)
            .map(|index| string(CFArrayGetValueAtIndex(groups.0, index)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((string(team.0)?, groups))
    }
}
