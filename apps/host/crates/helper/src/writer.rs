//! No production target implementation exists until native authorisation and
//! the published image layout have passed their required integration checks.
#[cfg(feature = "file-test")]
pub use ais_host_core::device::{WriteFailure, write_image};

pub fn available() -> bool {
    false
}
