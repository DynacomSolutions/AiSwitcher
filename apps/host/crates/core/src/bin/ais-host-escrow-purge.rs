//! Per-user cleanup entrypoint. Installation/removal belongs to the host app.
//! It receives a native-resolved registry directory, never a passphrase, drive
//! mount, source address or operation to execute. The backend is delete-only.

use ais_host_core::{
    escrow::{RetentionClock, SystemClock, native::NativeDeleter, purge_expired},
    registry::FileRegistry,
};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn main() -> std::process::ExitCode {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next();
    let directory = args.next().map(PathBuf::from);
    let watch = mode.as_deref() == Some(std::ffi::OsStr::new("--watch"));
    if (!watch && mode.as_deref() != Some(std::ffi::OsStr::new("--once")))
        || directory.is_none()
        || args.next().is_some()
    {
        eprintln!("Usage: ais-host-escrow-purge --once|--watch <private-registry-directory>");
        return std::process::ExitCode::FAILURE;
    }
    let directory = directory.expect("validated directory");
    let clock = RetentionClock::new(SystemClock::default());
    loop {
        let result = FileRegistry::open(&directory)
            .and_then(|mut registry| purge_expired(&mut NativeDeleter, &mut registry, &clock));
        let delay = match result {
            Ok(result) => {
                if !watch {
                    return if result.deletion_pending == 0 {
                        std::process::ExitCode::SUCCESS
                    } else {
                        std::process::ExitCode::FAILURE
                    };
                }
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |value| value.as_secs());
                result
                    .next_expiry
                    .map_or(60, |expiry| expiry.saturating_sub(now).clamp(1, 60))
            }
            Err(error) => {
                // Fixed safe errors, no paths or native store diagnostics.
                eprintln!("{error}");
                if !watch {
                    return std::process::ExitCode::FAILURE;
                }
                60
            }
        };
        // The login component runs independently of the UI. The nearest-expiry
        // timer is capped at a minute so resume/store availability is retried
        // even when native notifications are missed. No registry lock is held.
        std::thread::sleep(Duration::from_secs(delay));
    }
}
