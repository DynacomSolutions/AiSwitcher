//! The single gate for both persist erasure and lost-key reset.

use serde::Serialize;

/// The image pins the LUKS2 geometry that WritePlan::reset_persist zeroes, so
/// erasure is supported wherever the native helper can write.
pub const RESET_UNAVAILABLE: &str = "Persist erasure and lost-key reset need the Linux drive helper; this platform cannot write the drive yet.";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSupport {
    pub supported: bool,
    pub reason: &'static str,
}

pub fn support() -> ResetSupport {
    ResetSupport {
        supported: cfg!(target_os = "linux"),
        reason: if cfg!(target_os = "linux") {
            "Erases the encrypted storage and its keys. The next boot creates it again with a new passphrase."
        } else {
            RESET_UNAVAILABLE
        },
    }
}

/// Whether the confirmed Reset storage flow can run on this platform.
pub fn require_supported_reset() -> Result<(), String> {
    let support = support();
    if support.supported {
        Ok(())
    } else {
        Err(support.reason.into())
    }
}

const REMOVAL_ERASE: &str = "Erasing storage needs the connected drive and its own confirmation. Use Reset storage first, then remove the instance.";

/// A removal journal has no device authority, so its erase step defers to the
/// confirmed Reset storage flow instead of writing the drive itself.
pub fn removal_support() -> ResetSupport {
    ResetSupport {
        supported: false,
        reason: REMOVAL_ERASE,
    }
}
