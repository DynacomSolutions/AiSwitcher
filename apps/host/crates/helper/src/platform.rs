#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

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
