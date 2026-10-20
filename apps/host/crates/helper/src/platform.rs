#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "macos", feature = "file-test"))]
mod macos;
#[cfg(any(target_os = "windows", feature = "file-test"))]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{
    LinuxBlockTarget, collect_by_identity as collect_linux_by_identity,
    kernel_name as linux_kernel_name, list_eligible as list_linux_eligible,
    observe_unprivileged as observe_linux_unprivileged, partition_node as linux_partition_node,
    verify_connection as verify_linux_connection,
};
#[cfg(all(target_os = "linux", feature = "file-test"))]
pub use linux::{
    LinuxDiskObservation, LinuxDiskSnapshot, LinuxPartition,
    ObservationError as LinuxObservationError, collect_snapshot as collect_linux_snapshot,
    observe as observe_linux_snapshot, parse_snapshot as parse_linux_snapshot,
    recheck as recheck_linux_snapshot,
};

#[cfg(target_os = "macos")]
pub use macos::{MacBlockTarget, collect_snapshot as collect_macos_snapshot};
#[cfg(feature = "file-test")]
pub use macos::{
    MacDiskObservation, MacDiskSnapshot, MacPartition, ObservationError as MacObservationError,
    observe as observe_macos_snapshot, parse_snapshot as parse_macos_snapshot,
    recheck as recheck_macos_snapshot,
};

#[cfg(target_os = "windows")]
pub use windows::WindowsBlockTarget;
#[cfg(feature = "file-test")]
pub use windows::{
    ObservationError as WindowsObservationError, WindowsDiskObservation, WindowsDiskSnapshot,
    collect_windows_snapshot, observe_windows_snapshot, parse_windows_snapshot,
    recheck_windows_snapshot,
};

pub fn unavailable_reason() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        linux::REASON
    }
    #[cfg(target_os = "macos")]
    {
        macos::REASON
    }
    #[cfg(target_os = "windows")]
    {
        windows::REASON
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "This operating system has no supported disk helper."
    }
}
