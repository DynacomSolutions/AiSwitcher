//! A retained mount capability. No publication operation re-resolves its path.
#[cfg(unix)]
use std::path::Path;
use std::{fs::File, path::PathBuf};

pub struct ExchangeRoot {
    file: File,
    path: PathBuf,
    #[cfg(unix)]
    device: u64,
}

#[cfg(unix)]
impl ExchangeRoot {
    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
    fn open(path: &Path) -> Result<Self, String> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| "Cannot retain the exchange root.")?;
        let device = file
            .metadata()
            .map_err(|_| "Cannot inspect the exchange root.")?
            .dev();
        Ok(Self {
            file,
            path: path.into(),
            device,
        })
    }

    #[cfg(target_os = "linux")]
    pub fn open_verified(path: &Path, partition_device: u64) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        let root = Self::open(path)?;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: stat is writable and initialised only after a successful call.
        if unsafe { libc::fstatfs(root.file.as_raw_fd(), stat.as_mut_ptr()) } != 0
            || unsafe { stat.assume_init() }.f_type != 0x2011_bab0
            || root.device != partition_device
        {
            return Err("The retained exchange root is not the formatted partition.".into());
        }
        Ok(root)
    }

    /// The mount must be the exFAT filesystem of exactly this device node.
    #[cfg(target_os = "macos")]
    pub fn open_verified(path: &Path, device_node: &str) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        let root = Self::open(path)?;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: stat is writable and initialised only after a successful call.
        if unsafe { libc::fstatfs(root.file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err("The retained exchange root cannot be inspected.".into());
        }
        // SAFETY: fstatfs succeeded, and both names are NUL-terminated.
        let stat = unsafe { stat.assume_init() };
        let filesystem = unsafe { std::ffi::CStr::from_ptr(stat.f_fstypename.as_ptr()) };
        let source = unsafe { std::ffi::CStr::from_ptr(stat.f_mntfromname.as_ptr()) };
        if filesystem.to_bytes() != b"exfat" || source.to_bytes() != device_node.as_bytes() {
            return Err("The retained exchange root is not the formatted partition.".into());
        }
        Ok(root)
    }

    #[cfg(any(test, feature = "file-test"))]
    pub fn test_directory(path: &Path) -> Result<Self, String> {
        Self::open(path)
    }

    fn component(name: &str) -> Result<std::ffi::CString, String> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
            return Err("Invalid exchange filename.".into());
        }
        std::ffi::CString::new(name).map_err(|_| "Invalid exchange filename.".into())
    }

    fn at(&self, name: &str, flags: i32) -> Result<File, String> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        };
        let name = Self::component(name)?;
        // SAFETY: the parent descriptor and the single-component C string are live.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err("Cannot open the exchange entry safely.".into());
        }
        // SAFETY: openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        if file
            .metadata()
            .map_err(|_| "Cannot inspect exchange entry.")?
            .dev()
            != self.device
        {
            return Err("The exchange entry moved to another filesystem.".into());
        }
        Ok(file)
    }

    pub(crate) fn bundle_lock(&self) -> Result<File, String> {
        use std::os::unix::fs::MetadataExt;
        let file = self.at(".bundle-operation.lock", libc::O_RDWR | libc::O_CREAT)?;
        let metadata = file.metadata().map_err(|_| "Cannot inspect bundle lock.")?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err("Invalid bundle lock.".into());
        }
        fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "The inbox is busy.")?;
        Ok(file)
    }
    pub(crate) fn names(&self) -> Result<Vec<String>, String> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let entries = std::fs::read_dir(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
                .map_err(|_| "Cannot list retained inbox.")?;
            let mut names = Vec::new();
            for entry in entries.take(50_001) {
                let name = entry
                    .map_err(|_| "Cannot list inbox.")?
                    .file_name()
                    .into_string()
                    .map_err(|_| "Invalid inbox filename.")?;
                names.push(name);
            }
            if names.len() > 50_000 {
                return Err("Too many inbox entries.".into());
            }
            Ok(names)
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: the duplicate is handed to the directory stream, which owns it.
            let descriptor = unsafe { libc::dup(self.file.as_raw_fd()) };
            if descriptor < 0 {
                return Err("Cannot list retained inbox.".into());
            }
            // SAFETY: descriptor is a live directory descriptor owned here.
            let stream = unsafe { libc::fdopendir(descriptor) };
            if stream.is_null() {
                // SAFETY: fdopendir failed, so the descriptor is still ours.
                unsafe { libc::close(descriptor) };
                return Err("Cannot list retained inbox.".into());
            }
            // SAFETY: the duplicate shares its offset with the retained directory.
            unsafe { libc::rewinddir(stream) };
            let mut names = Vec::new();
            let result = loop {
                // SAFETY: stream is open; the entry is read before the next call.
                let entry = unsafe { libc::readdir(stream) };
                if entry.is_null() {
                    break Ok(());
                }
                // SAFETY: d_name is NUL-terminated within the entry.
                let raw = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
                let Ok(name) = raw.to_str() else {
                    break Err("Invalid inbox filename.");
                };
                if name == "." || name == ".." {
                    continue;
                }
                names.push(name.to_owned());
                if names.len() > 50_000 {
                    break Err("Too many inbox entries.");
                }
            };
            // SAFETY: closes the stream and its duplicated descriptor.
            unsafe { libc::closedir(stream) };
            result?;
            Ok(names)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Err("Image updates are unavailable on this platform.".into())
        }
    }

    pub(crate) fn directory(&self, name: &str, create: bool) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        let c_name = Self::component(name)?;
        if create {
            // SAFETY: live descriptor and C string, no path traversal.
            let result = unsafe { libc::mkdirat(self.file.as_raw_fd(), c_name.as_ptr(), 0o700) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return Err("Cannot create the exchange directory.".into());
            }
        }
        Ok(Self {
            file: self.at(name, libc::O_RDONLY | libc::O_DIRECTORY)?,
            path: self.path.join(name),
            device: self.device,
        })
    }

    pub(crate) fn open_file(&self, name: &str, create: bool) -> Result<File, String> {
        use std::os::unix::fs::MetadataExt;
        let file = self.at(
            name,
            if create {
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL
            } else {
                libc::O_RDONLY
            },
        )?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect the exchange file.")?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err("The exchange entry is not a private regular file.".into());
        }
        Ok(file)
    }

    pub(crate) fn optional_file(&self, name: &str) -> Result<Option<File>, String> {
        use std::os::fd::AsRawFd;
        let component = Self::component(name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: live directory descriptor, single component and writable stat.
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                component.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                Ok(None)
            } else {
                Err("Cannot inspect the exchange file.".into())
            };
        }
        self.open_file(name, false).map(Some)
    }

    pub(crate) fn remove_file(&self, name: &str) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        let name = Self::component(name)?;
        // SAFETY: the single component is confined to the retained directory.
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err("The update journal could not be removed.".into());
        }
        Ok(())
    }

    pub(crate) fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        use std::os::fd::AsRawFd;
        let from = Self::component(from)?;
        let to = Self::component(to)?;
        #[cfg(target_os = "linux")]
        // SAFETY: both names are confined to the retained directory.
        let result = unsafe {
            libc::renameat2(
                self.file.as_raw_fd(),
                from.as_ptr(),
                self.file.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        // SAFETY: both names are confined to the retained directory.
        let result = unsafe {
            libc::renameatx_np(
                self.file.as_raw_fd(),
                from.as_ptr(),
                self.file.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let result = {
            let _ = (from, to);
            -1
        };
        if result != 0 {
            return Err("Cannot publish the exchange file without replacement.".into());
        }
        self.sync()
    }

    pub(crate) fn remove(&self, name: &str) {
        use std::os::fd::AsRawFd;
        if let Ok(name) = Self::component(name) {
            // SAFETY: only the caller's private staging name is unlinked.
            unsafe {
                libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0);
            }
        }
    }

    pub(crate) fn available_bytes(&self) -> Result<u64, String> {
        use std::os::fd::AsRawFd;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: stat is writable and read only after success.
        if unsafe { libc::fstatvfs(self.file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err("Cannot inspect exchange free space.".into());
        }
        let stat = unsafe { stat.assume_init() };
        // fsblkcnt_t is u32 on macOS and u64 on Linux.
        #[allow(clippy::unnecessary_cast)]
        Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
}

// Other platforms fail closed.
#[cfg(not(any(unix, windows)))]
impl ExchangeRoot {
    pub(crate) fn bundle_lock(&self) -> Result<File, String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn names(&self) -> Result<Vec<String>, String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn directory(&self, _: &str, _: bool) -> Result<Self, String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn open_file(&self, _: &str, _: bool) -> Result<File, String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn optional_file(&self, _: &str) -> Result<Option<File>, String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn remove_file(&self, _: &str) -> Result<(), String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn rename(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn remove(&self, _: &str) {}
    pub(crate) fn available_bytes(&self) -> Result<u64, String> {
        Err("Unsupported platform.".into())
    }
}

#[cfg(windows)]
mod windows_root;

impl ExchangeRoot {
    /// The kernel-reported mount point this capability was opened on.
    pub fn mount_path(&self) -> &std::path::Path {
        &self.path
    }
    pub(crate) fn sync(&self) -> Result<(), String> {
        self.file
            .sync_all()
            .map_err(|_| "Cannot flush the exchange directory.".into())
    }
    pub(crate) fn display_path(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

/// One plain entry name: no separators, drive or stream syntax, control
/// characters, reserved trailing dot or space. Compiled everywhere so it is
/// tested everywhere; only the Windows root uses it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_component(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err("Invalid exchange filename.".into());
    }
    Ok(name)
}

/// `\\?\Volume{GUID}\` and nothing else.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn valid_volume_guid_path(path: &str) -> bool {
    let Some(guid) = path
        .strip_prefix("\\\\?\\Volume{")
        .and_then(|rest| rest.strip_suffix("}\\"))
    else {
        return false;
    };
    guid.len() == 36
        && guid.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod windows_name_tests {
    use super::*;

    #[test]
    fn entry_names_are_single_plain_components() {
        for good in [
            "inbox",
            "bundle-1.age",
            ".bundle-operation.lock",
            ".ais-x.partial",
        ] {
            assert_eq!(windows_component(good), Ok(good));
        }
        for bad in [
            "", ".", "..", "a/b", "a\\b", "C:x", "a:stream", "name.", "name ", "a*b", "a?b",
            "a\u{0}b", "con<",
        ] {
            assert!(windows_component(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_volume_guid_paths_are_exchange_roots() {
        assert!(valid_volume_guid_path(
            "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\"
        ));
        for bad in [
            "",
            "C:\\",
            "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}",
            "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdeg}\\",
            "\\\\?\\Volume{0123}\\",
            "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x",
        ] {
            assert!(!valid_volume_guid_path(bad), "{bad}");
        }
    }
}
