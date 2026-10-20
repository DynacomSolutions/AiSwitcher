//! Development-only regular-file targets and synthetic signed release fixtures.
//! This module is never compiled without the explicit `file-test` feature.
use crate::{
    device::{DeviceObservation, WriteTarget},
    release::{
        AssetIdentity, DownloadedImage, ImageVerifier, PublishedRelease, ReleaseSelection,
        TrustError, VerifiedImage, hex, select_release, sha256,
    },
};
use std::{
    fs::{File, OpenOptions},
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const SENTINEL: u8 = 0xa7;

pub fn fresh_file(directory: &Path, prefix: &str) -> io::Result<(PathBuf, File)> {
    // Random generated basenames only. No caller-supplied target path is opened.
    if !prefix
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || prefix.is_empty()
    {
        return Err(io::Error::other("invalid fixture prefix"));
    }
    let parent = directory.canonicalize()?;
    if !parent.is_dir() {
        return Err(io::Error::other("fixture directory required"));
    }
    let mut suffix = [0; 16];
    getrandom::fill(&mut suffix).map_err(|_| io::Error::other("fixture entropy unavailable"))?;
    let path = parent.join(format!("{prefix}-{}", hex(&suffix)));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("fixture must be a regular file"));
    }
    Ok((path, file))
}

pub struct SyntheticRelease {
    pub selection: ReleaseSelection,
    pub public_key: String,
    pub compressed: Vec<u8>,
    pub raw: Vec<u8>,
    pub sums: Vec<u8>,
    pub signature: Vec<u8>,
}

impl SyntheticRelease {
    pub fn new(raw: Vec<u8>) -> Self {
        let compressed = zstd::stream::encode_all(raw.as_slice(), 1).expect("compress fixture");
        Self::from_compressed(raw, compressed)
    }

    pub fn new_version(raw: Vec<u8>, version: u64) -> Self {
        let compressed = zstd::stream::encode_all(raw.as_slice(), 1).expect("compress fixture");
        let keys =
            minisign::KeyPair::generate_unencrypted_keypair().expect("synthetic signing key");
        Self::from_compressed_with_key(raw, compressed, &keys, version)
    }

    pub fn new_with_key(raw: Vec<u8>, keys: &minisign::KeyPair) -> Self {
        let compressed = zstd::stream::encode_all(raw.as_slice(), 1).expect("compress fixture");
        Self::from_compressed_with_key(raw, compressed, keys, 1)
    }

    pub fn from_compressed(raw: Vec<u8>, compressed: Vec<u8>) -> Self {
        let keys =
            minisign::KeyPair::generate_unencrypted_keypair().expect("synthetic signing key");
        Self::from_compressed_with_key(raw, compressed, &keys, 1)
    }

    fn from_compressed_with_key(
        raw: Vec<u8>,
        compressed: Vec<u8>,
        keys: &minisign::KeyPair,
        version: u64,
    ) -> Self {
        let tag = format!("live-v{version}.0.0");
        let name = format!("ais-live-x86_64-{tag}.img.zst");
        let sums = format!("{}  {name}\n", hex(&sha256(&compressed))).into_bytes();
        let signature = minisign::sign(None, &keys.sk, Cursor::new(&sums), None, None)
            .expect("sign fixture")
            .to_string()
            .into_bytes();
        let asset = |id, name: &str, size| AssetIdentity {
            id,
            name: name.to_owned(),
            size,
            revision: "SYNTHETIC_FIXTURE".to_owned(),
        };
        let selection = select_release(&[PublishedRelease {
            id: version,
            tag,
            published_at: version,
            draft: false,
            prerelease: false,
            assets: vec![
                asset(1, &name, compressed.len() as u64),
                asset(2, "SHA256SUMS", sums.len() as u64),
                asset(3, "SHA256SUMS.minisig", signature.len() as u64),
            ],
        }])
        .expect("synthetic release selection");
        Self {
            selection,
            public_key: keys.pk.to_box().expect("public key").to_string(),
            compressed,
            raw,
            sums,
            signature,
        }
    }

    pub fn download(&self, directory: &Path) -> io::Result<(PathBuf, DownloadedImage)> {
        let (path, mut source) = fresh_file(directory, "signed-source")?;
        source.write_all(&self.compressed)?;
        source.sync_all()?;
        Ok((
            path,
            DownloadedImage {
                source,
                image_identity: self.selection.image().clone(),
                sums_identity: self.selection.sums().clone(),
                signature_identity: self.selection.signature().clone(),
                sums: self.sums.clone(),
                signature: self.signature.clone(),
            },
        ))
    }

    pub fn verify(&self, directory: &Path) -> Result<(PathBuf, VerifiedImage), TrustError> {
        let (path, download) = self.download(directory)?;
        let image = ImageVerifier::synthetic(&self.public_key, &self.raw)?
            .verify(&self.selection, download)?;
        Ok((path, image))
    }

    pub fn verify_live_layout(
        &self,
        directory: &Path,
    ) -> Result<(PathBuf, VerifiedImage), TrustError> {
        let (path, download) = self.download(directory)?;
        let image = ImageVerifier::synthetic_live_layout(&self.public_key)?
            .verify(&self.selection, download)?;
        Ok((path, image))
    }
}

pub struct FileTarget {
    file: File,
    path: PathBuf,
    observation: DeviceObservation,
    locked: bool,
    lock_delay: std::time::Duration,
    tamper_mount_after_write: bool,
    interrupt_writes: usize,
    live_table: bool,
}

impl FileTarget {
    pub fn create(directory: &Path, capacity: u64) -> io::Result<Self> {
        if capacity == 0 || capacity > 16 * 1024 * 1024 || !capacity.is_multiple_of(512) {
            return Err(io::Error::other("fixture capacity limit"));
        }
        let (path, mut file) = fresh_file(directory, "disk-SYNTHETIC-FIXTURE")?;
        file.write_all(&vec![SENTINEL; capacity as usize])?;
        file.sync_all()?;
        let identity = file_identity(&file.metadata()?);
        let observation = DeviceObservation {
            os_identity: identity,
            connection_identity: path
                .file_name()
                .expect("generated name")
                .to_string_lossy()
                .into_owned(),
            display_identifier: "SYNTHETIC_FIXTURE_DISK".to_owned(),
            serial: None,
            model: Some("SYNTHETIC_FIXTURE_MODEL".into()),
            capacity_bytes: capacity,
            sector_bytes: 512,
            table_fingerprint: sha256(b"SYNTHETIC_FIXTURE_TABLE"),
            ancestry_fingerprint: sha256(b"SYNTHETIC_FIXTURE_ANCESTRY"),
            mount_fingerprint: sha256(b"SYNTHETIC_FIXTURE_MOUNTS"),
            external_usb: true,
            internal: false,
            system_backing: false,
            ancestry_complete: true,
            writable: true,
        };
        Ok(Self {
            file,
            path,
            observation,
            locked: false,
            lock_delay: std::time::Duration::ZERO,
            tamper_mount_after_write: false,
            interrupt_writes: 0,
            live_table: false,
        })
    }
    /// Sparse regular file for the real GPT and exFAT pipeline. The basename
    /// is generated internally and no caller-supplied target path is opened.
    pub fn create_sparse(directory: &Path, capacity: u64) -> io::Result<Self> {
        if !(1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&capacity)
            || !capacity.is_multiple_of(512)
        {
            return Err(io::Error::other("fixture capacity limit"));
        }
        let mut target = Self::create(directory, 1024 * 1024)?;
        target.file.set_len(0)?;
        target.file.set_len(capacity)?;
        target.observation.capacity_bytes = capacity;
        target.live_table = true;
        Ok(target)
    }
    pub fn reopen(mut self) -> io::Result<Self> {
        fs2::FileExt::unlock(&self.file)?;
        self.locked = false;
        Ok(self)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn read_all(&mut self) -> io::Result<Vec<u8>> {
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        self.file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    /// Test a separate open-file description, not a clone sharing one lock.
    pub fn competing_lock(&self) -> io::Result<()> {
        let second = OpenOptions::new().read(true).write(true).open(&self.path)?;
        second.try_lock().map_err(io::Error::from)
    }
    pub fn delay_lock(&mut self, duration: std::time::Duration) {
        self.lock_delay = duration;
    }
    pub fn tamper_mount_after_write(&mut self) {
        self.tamper_mount_after_write = true;
    }
    pub fn interrupt_writes(&mut self, count: usize) {
        self.interrupt_writes = count;
    }
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("SYNTHETIC_FIXTURE:{}:{}", metadata.dev(), metadata.ino())
}
#[cfg(not(unix))]
fn file_identity(metadata: &std::fs::Metadata) -> String {
    // File IDs on Windows require the native adapter. This harness uses creation
    // time only; it is not a physical-device identity implementation.
    format!("SYNTHETIC_FIXTURE:{:?}", metadata.created().ok())
}

impl WriteTarget for FileTarget {
    fn observe(&self) -> io::Result<DeviceObservation> {
        let current = self.file.metadata()?;
        let named = std::fs::symlink_metadata(&self.path)?;
        if !current.is_file()
            || !named.is_file()
            || file_identity(&current) != file_identity(&named)
            || file_identity(&current) != self.observation.os_identity
            || current.len() != self.observation.capacity_bytes
        {
            return Err(io::Error::other("fixture target changed"));
        }
        let mut observation = self.observation.clone();
        if self.live_table {
            use crate::device::{TABLE_WINDOW_BYTES, table_fingerprint};
            let mut file = self.file.try_clone()?;
            let position = file.stream_position()?;
            let mut head = vec![0; TABLE_WINDOW_BYTES];
            let mut tail = vec![0; TABLE_WINDOW_BYTES];
            file.rewind()?;
            file.read_exact(&mut head)?;
            file.seek(SeekFrom::End(-(TABLE_WINDOW_BYTES as i64)))?;
            file.read_exact(&mut tail)?;
            file.seek(SeekFrom::Start(position))?;
            observation.table_fingerprint =
                table_fingerprint(&head, &tail).map_err(io::Error::other)?;
        }
        Ok(observation)
    }
    fn lock_exclusive(&mut self) -> io::Result<()> {
        if self.locked {
            return Err(io::Error::other("target already used"));
        }
        self.file.try_lock().map_err(io::Error::from)?;
        self.locked = true;
        std::thread::sleep(self.lock_delay);
        Ok(())
    }
    fn flush_durable(&mut self) -> io::Result<()> {
        self.file.sync_all()
    }
}
impl Read for FileTarget {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.read(bytes)
    }
}
impl Write for FileTarget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.interrupt_writes > 0 {
            self.interrupt_writes -= 1;
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        let count = self.file.write(bytes)?;
        if count > 0 && self.tamper_mount_after_write {
            self.observation.mount_fingerprint[0] ^= 1;
            self.tamper_mount_after_write = false;
        }
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
impl Seek for FileTarget {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}

/// Fault injection wraps the same opened-file writer used by the harness.
pub struct FaultTarget {
    pub inner: FileTarget,
    pub observed: Option<DeviceObservation>,
    pub maximum_write: usize,
    pub fail_after: Option<usize>,
    pub disconnect_after: Option<usize>,
    pub corrupt_readback: bool,
    pub fail_flush: bool,
    pub deny_lock: bool,
    pub written: usize,
}

impl FaultTarget {
    pub fn new(inner: FileTarget) -> Self {
        Self {
            inner,
            observed: None,
            maximum_write: usize::MAX,
            fail_after: None,
            disconnect_after: None,
            corrupt_readback: false,
            fail_flush: false,
            deny_lock: false,
            written: 0,
        }
    }
}
impl WriteTarget for FaultTarget {
    fn observe(&self) -> io::Result<DeviceObservation> {
        if self
            .disconnect_after
            .is_some_and(|after| self.written >= after)
        {
            return Err(io::Error::other("synthetic disconnection"));
        }
        self.observed
            .clone()
            .map_or_else(|| self.inner.observe(), Ok)
    }
    fn lock_exclusive(&mut self) -> io::Result<()> {
        if self.deny_lock {
            return Err(io::Error::other("synthetic lock refusal"));
        }
        self.inner.lock_exclusive()
    }
    fn flush_durable(&mut self) -> io::Result<()> {
        if self.fail_flush {
            return Err(io::Error::other("synthetic flush failure"));
        }
        self.inner.flush_durable()
    }
}
impl Read for FaultTarget {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(bytes)?;
        if count > 0 && self.corrupt_readback {
            bytes[0] ^= 1;
        }
        Ok(count)
    }
}
impl Write for FaultTarget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut limit = bytes.len().min(self.maximum_write);
        if let Some(after) = self.fail_after {
            if self.written >= after {
                return Err(io::Error::other("synthetic storage full"));
            }
            limit = limit.min(after - self.written);
        }
        let count = self.inner.write(&bytes[..limit])?;
        self.written += count;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
impl Seek for FaultTarget {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.inner.seek(position)
    }
}

/// Full regular-file scenario driver. All paths are newly created fixture files.
/// It intentionally leaves fixtures in place for inspection by the coordinator.
pub fn run_write_safety(directory: &Path) -> Result<usize, String> {
    use crate::device::{ConfirmationBook, WriteFailure, WritePlan, write_image};
    use std::time::{Duration, Instant};
    let fixture = SyntheticRelease::new(vec![0x45; 128 * 1024]);
    let mut passed = 0;
    for scenario in 0..26 {
        let (source_path, mut image) = fixture.verify(directory).map_err(|e| e.to_string())?;
        let mut target =
            FaultTarget::new(FileTarget::create(directory, 256 * 1024).map_err(|e| e.to_string())?);
        let observed = target.observe().map_err(|e| e.to_string())?;
        let plan =
            WritePlan::synthetic_image(&image, observed.clone()).map_err(|e| e.to_string())?;
        let before = target.inner.read_all().map_err(|e| e.to_string())?;
        let now = Instant::now();
        let mut book = ConfirmationBook::default();
        let ticket = book
            .issue(
                &plan,
                &observed.display_identifier,
                if scenario == 3 {
                    now - Duration::from_secs(11)
                } else {
                    now
                },
                Duration::from_secs(10),
            )
            .map_err(|e| e.to_string())?;
        let mut changed = observed.clone();
        match scenario {
            0 => {} // successful full write
            1 => target.maximum_write = 97,
            2 => book.invalidate(),
            3 => {} // expired ticket below
            4 => {} // cancellation below
            5 => target.deny_lock = true,
            6 => {
                OpenOptions::new()
                    .write(true)
                    .open(source_path)
                    .and_then(|mut file| file.write_all(&[0]))
                    .map_err(|e| e.to_string())?;
            }
            7 => changed.capacity_bytes += 512,
            8 => changed.os_identity.push('x'),
            9 => changed.connection_identity.push('x'),
            10 => changed.serial = Some("SYNTHETIC_FIXTURE_SERIAL".into()),
            11 => changed.table_fingerprint[0] ^= 1,
            12 => changed.ancestry_fingerprint[0] ^= 1,
            13 => changed.mount_fingerprint[0] ^= 1,
            14 => changed.internal = true,
            15 => changed.system_backing = true,
            16 => changed.ancestry_complete = false,
            17 => changed.connection_identity.clear(),
            18 => target.fail_after = Some(1024),
            19 => target.disconnect_after = Some(64 * 1024),
            20 => target.fail_flush = true,
            21 => target.corrupt_readback = true,
            22 => {} // cancellation during the write below
            23 => target.maximum_write = 0,
            24 => changed.external_usb = false,
            25 => changed.writable = false,
            _ => unreachable!(),
        }
        if changed != observed {
            target.observed = Some(changed);
        }
        let mut checks = 0;
        let result = write_image(&mut target, &mut image, &plan, &mut book, &ticket, || {
            checks += 1;
            scenario == 4 || (scenario == 22 && checks >= 5)
        });
        let after = target.inner.read_all().map_err(|e| e.to_string())?;
        let end = image.len() as usize;
        if after[end..] != before[end..] {
            return Err(format!("scenario {scenario}: sentinel changed"));
        }
        if scenario <= 1 {
            if result != Ok(image.len()) || after[..end] != fixture.raw {
                return Err(format!(
                    "scenario {scenario}: write/readback failed: {result:?}"
                ));
            }
            if target.inner.competing_lock().is_ok() {
                return Err("separate file description acquired the operation lock".into());
            }
        } else if (18..=22).contains(&scenario) {
            if !matches!(result, Err(WriteFailure::Incomplete { .. })) {
                return Err(format!(
                    "scenario {scenario}: missing incomplete state: {result:?}"
                ));
            }
        } else if !matches!(result, Err(WriteFailure::Refused(_))) || after != before {
            return Err(format!(
                "scenario {scenario}: refusal mutated target or succeeded: {result:?}"
            ));
        }
        passed += 1;
    }
    Ok(passed)
}
