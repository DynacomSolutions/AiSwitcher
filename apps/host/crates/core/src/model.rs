//! Pinned local model download. The pin (repository, commit, file, size and
//! SHA-256) comes from the reviewed catalogue; nothing downloaded is used until
//! its size and digest match exactly.
use crate::{
    create::ModelEntry,
    fetch::{FetchError, Http, approved_address_on},
    release::{hex, sha256_reader},
};
use std::{
    fs::{self, File, OpenOptions},
    io::Seek,
    path::{Path, PathBuf},
};
use thiserror::Error;

pub const MODEL_HOSTS: &[&str] = &["huggingface.co", "hf.co"];

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("The model download failed or was incomplete.")]
    Download,
    #[error("The downloaded model does not match its pinned size or digest.")]
    Pin,
    #[error("There is not enough free space for the model.")]
    Space,
    #[error("Local file handling failed.")]
    Io(#[from] std::io::Error),
}

impl From<FetchError> for ModelError {
    fn from(_: FetchError) -> Self {
        Self::Download
    }
}

pub fn model_url(entry: &ModelEntry) -> String {
    format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        entry.repository, entry.revision, entry.file
    )
}

/// A model whose bytes matched the pin; the open handle is the only thing the
/// later publish step uses.
pub struct VerifiedModel {
    pub entry: ModelEntry,
    pub path: PathBuf,
    pub file: File,
}

fn matches_pin(file: &mut File, entry: &ModelEntry) -> Result<bool, ModelError> {
    if file.metadata()?.len() != entry.size_bytes {
        return Ok(false);
    }
    file.rewind()?;
    Ok(hex(&sha256_reader(file)?) == entry.sha256)
}

#[cfg(unix)]
pub(crate) fn free_bytes(directory: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(directory.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: path is NUL-terminated and stats is writable storage for statvfs.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statvfs returned success and initialised the structure.
    let stats = unsafe { stats.assume_init() };
    #[allow(clippy::unnecessary_cast)] // field widths differ between platforms
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(windows)]
pub(crate) fn free_bytes(directory: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    // SAFETY: path is NUL-terminated, free is writable and the unused outputs may be null.
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn free_bytes(_directory: &Path) -> Option<u64> {
    None
}

/// Download (or reuse and re-hash a cached copy of) the pinned model. A cache
/// entry is never trusted: it is hashed again on every use.
pub fn obtain_model(
    http: &dyn Http,
    entry: &ModelEntry,
    cache: &Path,
) -> Result<VerifiedModel, ModelError> {
    let url = model_url(entry);
    if !approved_address_on(&url, MODEL_HOSTS) {
        return Err(ModelError::Download);
    }
    fs::create_dir_all(cache)?;
    let final_path = cache.join(&entry.file);
    if let Ok(mut cached) = File::open(&final_path) {
        if matches_pin(&mut cached, entry)? {
            cached.rewind()?;
            return Ok(VerifiedModel {
                entry: entry.clone(),
                path: final_path,
                file: cached,
            });
        }
        fs::remove_file(&final_path)?;
    }
    if free_bytes(cache).is_some_and(|free| free < entry.size_bytes) {
        return Err(ModelError::Space);
    }
    let partial = cache.join(format!("{}.part", entry.file));
    let _ = fs::remove_file(&partial);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&partial)?;
    let result = http
        .get(&url, entry.size_bytes, &mut file)
        .map_err(ModelError::from)
        .and_then(|_| file.sync_all().map_err(ModelError::from))
        .and_then(|_| matches_pin(&mut file, entry))
        .and_then(|ok| if ok { Ok(()) } else { Err(ModelError::Pin) });
    if let Err(error) = result {
        drop(file);
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, &final_path)?;
    file.rewind()?;
    Ok(VerifiedModel {
        entry: entry.clone(),
        path: final_path,
        file,
    })
}
