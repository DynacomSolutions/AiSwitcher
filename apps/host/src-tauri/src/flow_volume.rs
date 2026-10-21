//! Finds and mounts a registered drive's exchange partition for the flows. It
//! reuses the update path's discovery and mount code (never a second one) and
//! releases the mount when the flow command finishes.

use ais_host_core::update::InstalledImage;
use std::{path::PathBuf, sync::Arc};

/// A mounted exchange directory. Dropping it runs the release step, so a flow
/// that fails or panics still unmounts what it mounted.
pub struct MountedVolume {
    pub path: PathBuf,
    release: Option<Box<dyn FnOnce() + Send>>,
}

impl MountedVolume {
    pub fn new(path: PathBuf, release: impl FnOnce() + Send + 'static) -> Self {
        Self {
            path,
            release: Some(Box::new(release)),
        }
    }
}

impl Drop for MountedVolume {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}

/// Maps the registry's record of an installed image to its mounted exchange.
pub type LocateExchange =
    Arc<dyn Fn(&InstalledImage) -> Result<MountedVolume, String> + Send + Sync>;

#[cfg(any(test, not(any(target_os = "linux", target_os = "macos"))))]
pub fn unavailable() -> LocateExchange {
    Arc::new(|_| Err("The drive's exchange volume is not available.".into()))
}

/// Linux: the same steps as an update. The connected disk is chosen by the
/// registry's hardware hint, its GPT is read through the helper's read-only
/// preview, and partition 4 is mounted through udisks and verified against the
/// recorded partition identities.
#[cfg(target_os = "linux")]
pub fn native_locator(app: tauri::AppHandle) -> LocateExchange {
    use tauri::Manager;
    Arc::new(move |installed| {
        let state = app.state::<crate::ConfirmationSession>();
        let _media = state.lock_media()?;
        let mut matches = crate::native_devices().into_iter().filter(|device| {
            ais_host_core::update::hardware_hint(device) == installed.hardware_hint
        });
        let (Some(device), None) = (matches.next(), matches.next()) else {
            return Err("The drive is not connected, or more than one drive matches.".into());
        };
        let snapshot = crate::preview_update_native(&device.os_identity)?;
        let parts = snapshot
            .partitions(&installed.identity)
            .map_err(|_| "The drive's disk or partition identities changed.")?;
        let observation = snapshot.observation.clone();
        let root = crate::ExchangeVolume::mount_parts(
            &crate::UdisksVolume,
            &observation,
            ais_host_core::update::partition_range(&parts[3]),
            &installed.identity,
        )?;
        let path = root.mount_path().to_owned();
        Ok(MountedVolume::new(path, move || {
            // The retained directory must be closed before the unmount.
            drop(root);
            let _ = crate::ExchangeVolume::unmount(&crate::UdisksVolume, &observation);
        }))
    })
}

#[cfg(target_os = "macos")]
pub fn native_locator(_app: tauri::AppHandle) -> LocateExchange {
    Arc::new(|installed| crate::macos_volume::mount(&installed.identity.partitions[3]))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn native_locator(_app: tauri::AppHandle) -> LocateExchange {
    unavailable()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn dropping_a_volume_releases_it_exactly_once() {
        let released = Arc::new(AtomicUsize::new(0));
        let counter = released.clone();
        let volume = MountedVolume::new("/synthetic".into(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(released.load(Ordering::SeqCst), 0);
        drop(volume);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
}
