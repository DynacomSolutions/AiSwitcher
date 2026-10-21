//! The single gate for both persist erasure and lost-key reset.

use serde::Serialize;

pub const RESET_UNAVAILABLE: &str = "Persist erasure and lost-key reset are not yet supported: the live image has not published verified LUKS metadata and keyslot geometry.";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSupport {
    pub supported: bool,
    pub reason: &'static str,
}

pub fn support() -> ResetSupport {
    ResetSupport {
        supported: false,
        reason: RESET_UNAVAILABLE,
    }
}

pub fn require_supported_reset() -> Result<(), String> {
    // TODO(B Task 3): consume proven LUKS geometry and boot reset fixtures, then
    // route both operations through the existing confirmed WritePlan helper.
    // No geometry, write plan, device path or raw-write fallback is guessed here.
    Err(RESET_UNAVAILABLE.into())
}
