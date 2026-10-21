//! The Windows exchange root. The volume is opened by its volume GUID path
//! (`\\?\Volume{...}\`), so no drive letter is involved. Entries are opened
//! with `FILE_FLAG_OPEN_REPARSE_POINT` and refused when they are reparse
//! points, which covers symbolic links, junctions and mount points.

use super::{ExchangeRoot, windows_component};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetVolumeInformationW, MoveFileExW,
};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const SHARE_ALL: u32 = 7;
const EXCHANGE_LABEL: &str = "AISX";

fn wide(path: &Path) -> Vec<u16> {
    OsStr::new(path).encode_wide().chain(Some(0)).collect()
}

fn plain(file: &File) -> Result<fs::Metadata, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect the exchange entry.".to_string())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("The exchange entry is a link.".into());
    }
    Ok(metadata)
}

impl ExchangeRoot {
    fn open_directory(path: &Path) -> Result<Self, String> {
        // Write access lets the directory itself be flushed after a rename.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| "Cannot retain the exchange root.".to_string())?;
        if !plain(&file)?.is_dir() {
            return Err("The exchange root is not a directory.".into());
        }
        Ok(Self {
            file,
            path: path.into(),
        })
    }

    /// Open the exFAT volume named by a volume GUID path. The caller has
    /// already matched the volume to its disk, offset and partition GUID.
    pub fn open_verified(volume: &Path) -> Result<Self, String> {
        let name = volume.to_string_lossy();
        if !crate::exchange_root::valid_volume_guid_path(&name) {
            return Err("The exchange volume path is invalid.".into());
        }
        let root = Self::open_directory(volume)?;
        let path = wide(volume);
        let mut label = [0u16; 64];
        let mut filesystem = [0u16; 64];
        // SAFETY: the path is NUL-terminated and the buffers have the stated lengths.
        let ok = unsafe {
            GetVolumeInformationW(
                path.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        };
        let text = |buffer: &[u16]| {
            let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
            String::from_utf16_lossy(&buffer[..end])
        };
        if ok == 0 || text(&filesystem) != "exFAT" || text(&label) != EXCHANGE_LABEL {
            return Err("The retained exchange root is not the formatted partition.".into());
        }
        Ok(root)
    }

    #[cfg(any(test, feature = "file-test"))]
    pub fn test_directory(path: &Path) -> Result<Self, String> {
        Self::open_directory(path)
    }

    fn open_entry(&self, name: &str, create: bool) -> Result<File, String> {
        let mut options = OpenOptions::new();
        if create {
            options.read(true).write(true).create_new(true);
        } else {
            options.read(true);
        }
        let file = options
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(self.path.join(windows_component(name)?))
            .map_err(|_| "Cannot open the exchange entry safely.".to_string())?;
        if !plain(&file)?.is_file() {
            return Err("The exchange entry is not a private regular file.".into());
        }
        Ok(file)
    }

    pub(crate) fn bundle_lock(&self) -> Result<File, String> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(self.path.join(".bundle-operation.lock"))
            .map_err(|_| "Cannot open the bundle lock.".to_string())?;
        if !plain(&file)?.is_file() {
            return Err("Invalid bundle lock.".into());
        }
        fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "The inbox is busy.")?;
        Ok(file)
    }

    pub(crate) fn names(&self) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.path)
            .map_err(|_| "Cannot list retained inbox.")?
            .take(50_001)
        {
            names.push(
                entry
                    .map_err(|_| "Cannot list inbox.")?
                    .file_name()
                    .into_string()
                    .map_err(|_| "Invalid inbox filename.")?,
            );
        }
        if names.len() > 50_000 {
            return Err("Too many inbox entries.".into());
        }
        Ok(names)
    }

    pub(crate) fn directory(&self, name: &str, create: bool) -> Result<Self, String> {
        let path = self.path.join(windows_component(name)?);
        if create
            && let Err(error) = fs::create_dir(&path)
            && error.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err("Cannot create the exchange directory.".into());
        }
        Self::open_directory(&path)
    }

    pub(crate) fn open_file(&self, name: &str, create: bool) -> Result<File, String> {
        self.open_entry(name, create)
    }

    pub(crate) fn optional_file(&self, name: &str) -> Result<Option<File>, String> {
        match fs::symlink_metadata(self.path.join(windows_component(name)?)) {
            Ok(_) => self.open_entry(name, false).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("Cannot inspect the exchange file.".into()),
        }
    }

    pub(crate) fn remove_file(&self, name: &str) -> Result<(), String> {
        fs::remove_file(self.path.join(windows_component(name)?))
            .map_err(|_| "The update journal could not be removed.".into())
    }

    /// Publish without replacing: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`
    /// fails when the target exists.
    pub(crate) fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let from = wide(&self.path.join(windows_component(from)?));
        let to = wide(&self.path.join(windows_component(to)?));
        // SAFETY: both paths are NUL-terminated.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
            return Err("Cannot publish the exchange file without replacement.".into());
        }
        self.sync()
    }

    pub(crate) fn remove(&self, name: &str) {
        if let Ok(name) = windows_component(name) {
            let _ = fs::remove_file(self.path.join(name));
        }
    }

    pub(crate) fn available_bytes(&self) -> Result<u64, String> {
        let path = wide(&self.path);
        let mut available = 0u64;
        // SAFETY: the path is NUL-terminated and the output is a writable u64.
        if unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("Cannot inspect exchange free space.".into());
        }
        Ok(available)
    }
}
