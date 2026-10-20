//! A retained mount capability. No publication operation re-resolves its path.
use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub struct ExchangeRoot {
    file: File,
    path: PathBuf,
    #[cfg(unix)]
    device: u64,
}

#[cfg(unix)]
impl ExchangeRoot {
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

    pub(crate) fn rename(&self, from: &str, to: &str) -> Result<(), String> {
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
        #[cfg(not(target_os = "linux"))]
        let result = -1;
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
        Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
    }
}

// Native creation is currently Linux-only; other platforms fail closed.
#[cfg(not(unix))]
impl ExchangeRoot {
    pub(crate) fn directory(&self, _: &str, _: bool) -> Result<Self, String> {
        Err("Unsupported platform.".into())
    }
    pub(crate) fn open_file(&self, _: &str, _: bool) -> Result<File, String> {
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

impl ExchangeRoot {
    pub(crate) fn sync(&self) -> Result<(), String> {
        self.file
            .sync_all()
            .map_err(|_| "Cannot flush the exchange directory.".into())
    }
    pub(crate) fn display_path(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}
