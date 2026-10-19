//! Mounted exFAT exchange access. Native volume discovery supplies the mount and
//! public identity-manifest location; neither is accepted from the webview.
//! The public driveId is a routing check, not cryptographic authentication.

use crate::{
    bundle::{self, BundleOperationLock},
    contract::{
        Bundle, BundleKind, BundleManifest, MAX_INBOX_BYTES, MAX_OUTBOX_BYTES, safe_relative_path,
        sha256_hex,
    },
    escrow::{ExposeSecret, SecretString},
    flow_state::DriveBinding,
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};
use zeroize::Zeroize;

pub struct MountedExchange {
    root: PathBuf,
    identity_manifest: PathBuf,
    binding: DriveBinding,
    passphrase: SecretString,
}

pub struct ExchangeLock {
    inner: BundleOperationLock,
    root: PathBuf,
}

/// Only this module constructs authenticated exchange snapshots. No public
/// deserialiser can turn an untrusted lastInboxSeq into acknowledged state.
pub struct ExchangeSnapshot {
    pub(crate) binding: DriveBinding,
    pub(crate) inbox: Option<AuthenticatedBundle>,
    pub(crate) outbox: Option<AuthenticatedBundle>,
    fingerprint: String,
}

pub(crate) struct AuthenticatedBundle {
    pub bundle: Bundle,
    pub digest: String,
}

impl Drop for AuthenticatedBundle {
    fn drop(&mut self) {
        self.bundle.tar_bytes.zeroize();
        for bytes in self.bundle.files.values_mut() {
            bytes.zeroize();
        }
    }
}

impl ExchangeSnapshot {
    pub fn binding(&self) -> &DriveBinding {
        &self.binding
    }
    pub fn inbox_manifest(&self) -> Option<&BundleManifest> {
        self.inbox.as_ref().map(|b| &b.bundle.manifest)
    }
    pub fn outbox_manifest(&self) -> Option<&BundleManifest> {
        self.outbox.as_ref().map(|b| &b.bundle.manifest)
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

impl MountedExchange {
    /// `identity_manifest` is a relative location resolved by native creation /
    /// discovery. Read only its agreed driveId projection, retaining other
    /// metadata untouched. This adds no fields to B's encrypted bundle format.
    pub fn open(
        native_mount: PathBuf,
        identity_manifest: &str,
        binding: DriveBinding,
        passphrase: SecretString,
    ) -> Result<Self, String> {
        binding.validate()?;
        if !safe_relative_path(identity_manifest) {
            return Err("unsafe exchange identity manifest location".into());
        }
        check_directory(&native_mount)?;
        let result = Self {
            identity_manifest: native_mount.join(identity_manifest),
            root: native_mount,
            binding,
            passphrase,
        };
        result.identity()?;
        Ok(result)
    }

    pub fn binding(&self) -> &DriveBinding {
        &self.binding
    }

    pub fn lock(&self) -> Result<ExchangeLock, String> {
        self.identity()?;
        check_directory(&self.root.join("inbox"))?;
        let inner = bundle::acquire_bundle_operation_lock(&self.root.join("inbox"))
            .map_err(|_| "exchange inbox is busy or unavailable")?;
        self.identity()?;
        Ok(ExchangeLock {
            inner,
            root: self.root.clone(),
        })
    }

    pub fn snapshot(&self) -> Result<ExchangeSnapshot, String> {
        let identity = self.identity()?;
        let inbox = self.read_latest("inbox", BundleKind::Inbox)?;
        let outbox = self.read_latest("outbox", BundleKind::Outbox)?;
        let fingerprint = fingerprint(
            &identity,
            inbox.as_ref().map(|b| b.1.as_str()),
            outbox.as_ref().map(|b| b.1.as_str()),
        );
        let result = ExchangeSnapshot {
            binding: self.binding.clone(),
            inbox: inbox.map(|b| b.0),
            outbox: outbox.map(|b| b.0),
            fingerprint,
        };
        self.recheck(&result)?;
        Ok(result)
    }

    /// Log retrieval is independent of the inbox, including a missing or
    /// damaged inbox. Authenticate the outbox and recheck its routing identity
    /// and ciphertext before releasing any plaintext to the receiver.
    pub(crate) fn read_outbox(&self) -> Result<Option<AuthenticatedBundle>, String> {
        let identity = self.identity()?;
        let outbox = self.read_latest("outbox", BundleKind::Outbox)?;
        let current = self
            .latest_bytes("outbox", MAX_OUTBOX_BYTES)?
            .map(|(_, bytes)| sha256_hex(&bytes));
        if self.identity()? != identity || outbox.as_ref().map(|b| &b.1) != current.as_ref() {
            return Err("outbox changed; retry log retrieval".into());
        }
        Ok(outbox.map(|b| b.0))
    }

    pub fn recheck(&self, expected: &ExchangeSnapshot) -> Result<(), String> {
        if expected.binding != self.binding {
            return Err("exchange belongs to another drive generation".into());
        }
        let identity = self.identity()?;
        let inbox = self
            .latest_bytes("inbox", MAX_INBOX_BYTES)?
            .map(|(_, bytes)| sha256_hex(&bytes));
        let outbox = self
            .latest_bytes("outbox", MAX_OUTBOX_BYTES)?
            .map(|(_, bytes)| sha256_hex(&bytes));
        if fingerprint(&identity, inbox.as_deref(), outbox.as_deref()) != expected.fingerprint {
            return Err("exchange changed; review a new preview".into());
        }
        Ok(())
    }

    pub(crate) fn publish(
        &self,
        lock: &ExchangeLock,
        expected: &ExchangeSnapshot,
        manifest: &BundleManifest,
        files: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), String> {
        if lock.root != self.root || manifest.kind != BundleKind::Inbox {
            return Err("publication does not match the locked exchange".into());
        }
        self.recheck(expected)?;
        // Existing publisher: sibling temporary file, fsync, atomic rename,
        // directory fsync, authenticated readback, authenticated-only pruning.
        bundle::write_bundle_file_locked(
            &lock.inner,
            &self.root.join("inbox"),
            manifest,
            files,
            self.passphrase.expose_secret(),
        )
        .map_err(|_| "inbox publication failed; refresh status before retrying")?;
        self.identity()?;
        Ok(())
    }

    fn identity(&self) -> Result<String, String> {
        check_directory(&self.root)?;
        let bytes = read_regular(&self.identity_manifest, 64 * 1024)?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid exchange identity manifest")?;
        if value.get("driveId").and_then(|v| v.as_str()) != Some(self.binding.drive_id()) {
            return Err("exchange drive identity does not match the selected drive".into());
        }
        Ok(sha256_hex(&bytes))
    }

    fn read_latest(
        &self,
        directory: &str,
        kind: BundleKind,
    ) -> Result<Option<(AuthenticatedBundle, String)>, String> {
        let maximum = match kind {
            BundleKind::Inbox => MAX_INBOX_BYTES,
            BundleKind::Outbox => MAX_OUTBOX_BYTES,
        };
        let Some((path, bytes)) = self.latest_bytes(directory, maximum)? else {
            return Ok(None);
        };
        // No fallback to an older bundle after failed authentication.
        let bundle = bundle::decrypt_bundle(&bytes, self.passphrase.expose_secret(), kind)?;
        bundle::validate_bundle_filename_sequence(&path, bundle.manifest.seq)?;
        let digest = sha256_hex(&bundle.tar_bytes);
        Ok(Some((
            AuthenticatedBundle { bundle, digest },
            sha256_hex(&bytes),
        )))
    }

    fn latest_bytes(
        &self,
        directory: &str,
        maximum: usize,
    ) -> Result<Option<(PathBuf, Vec<u8>)>, String> {
        let directory = self.root.join(directory);
        check_directory(&directory)?;
        let mut latest = None;
        for (count, entry) in fs::read_dir(&directory)
            .map_err(|_| "cannot read exchange directory")?
            .enumerate()
        {
            if count >= 4096 {
                return Err("exchange directory has too many entries".into());
            }
            let entry = entry.map_err(|_| "cannot inspect exchange entry")?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err("invalid exchange filename".into());
            };
            if name.starts_with('.') || !name.ends_with(".age") {
                continue;
            }
            let path = entry.path();
            let sequence = bundle::bundle_sequence_from_filename(&path)?;
            if latest.as_ref().is_none_or(|(n, _)| sequence > *n) {
                latest = Some((sequence, path));
            }
        }
        latest
            .map(|(_, path)| read_regular(&path, maximum).map(|bytes| (path, bytes)))
            .transpose()
    }
}

fn fingerprint(identity: &str, inbox: Option<&str>, outbox: Option<&str>) -> String {
    sha256_hex(
        format!(
            "{identity}:{}:{}",
            inbox.unwrap_or("missing"),
            outbox.unwrap_or("missing")
        )
        .as_bytes(),
    )
}

pub(crate) fn check_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("native directory must be absolute".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("unsafe native directory".into());
        }
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "native directory is unavailable")?;
        if is_link(&metadata) || !metadata.is_dir() {
            return Err("native directory contains a link or non-directory".into());
        }
    }
    Ok(())
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(crate) fn open_regular(path: &Path, write_new: bool) -> Result<File, String> {
    check_directory(path.parent().ok_or("file has no parent directory")?)?;
    let mut options = OpenOptions::new();
    if write_new {
        options.write(true).create_new(true);
    } else {
        options.read(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options
        .open(path)
        .map_err(|_| "cannot safely open flow file")?;
    let metadata = file.metadata().map_err(|_| "cannot inspect flow file")?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err("flow file must be regular and not a link".into());
    }
    Ok(file)
}

pub(crate) fn read_regular(path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    let file = open_regular(path, false)?;
    if file
        .metadata()
        .map_err(|_| "cannot inspect flow file")?
        .len()
        > maximum as u64
    {
        return Err("flow file exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read flow file")?;
    if bytes.len() > maximum {
        return Err("flow file exceeds its size limit".into());
    }
    Ok(bytes)
}
