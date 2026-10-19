use crate::contract::{
    Bundle, BundleKind, BundleManifest, MAX_INBOX_BYTES, MAX_MANIFEST_BYTES, MAX_OUTBOX_BYTES,
    validate_manifest,
};
use age::{Decryptor, Encryptor, secrecy::SecretString};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    iter,
    path::{Path, PathBuf},
};

const BLOCK: usize = 512;

/// Cross-process lock for one drive's bundle directory. Hold it across sequence
/// persistence and publication so separate app instances cannot reserve the
/// same sequence or race the completed filename.
pub struct BundleOperationLock {
    directory: PathBuf,
    _file: File,
}

pub fn acquire_bundle_operation_lock(directory: &Path) -> Result<BundleOperationLock, String> {
    fs::create_dir_all(directory).map_err(|e| format!("cannot create bundle directory: {e}"))?;
    let file = lock_bundle_directory(directory)?;
    Ok(BundleOperationLock {
        directory: directory.to_path_buf(),
        _file: file,
    })
}

fn max_bytes(kind: BundleKind) -> usize {
    match kind {
        BundleKind::Inbox => MAX_INBOX_BYTES,
        BundleKind::Outbox => MAX_OUTBOX_BYTES,
    }
}

fn field_string(field: &[u8]) -> Result<String, String> {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    std::str::from_utf8(&field[..end])
        .map(str::to_owned)
        .map_err(|_| "tar path is not UTF-8".into())
}

fn octal(field: &[u8]) -> Result<u64, String> {
    let text = field
        .iter()
        .copied()
        .take_while(|b| *b != 0)
        .collect::<Vec<_>>();
    let text = std::str::from_utf8(&text)
        .map_err(|_| "invalid tar numeric field")?
        .trim();
    if text.is_empty() || !text.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return Err("invalid tar numeric field".into());
    }
    u64::from_str_radix(text, 8).map_err(|_| "tar numeric field is out of range".into())
}

type ParsedTar = (BTreeMap<String, Vec<u8>>, Vec<u8>);

fn parse_tar(raw: &[u8], limit: usize) -> Result<ParsedTar, String> {
    if raw.len() > limit || raw.len() < BLOCK * 3 || !raw.len().is_multiple_of(BLOCK) {
        return Err("tar size or block alignment is invalid".into());
    }
    let mut files = BTreeMap::new();
    let mut offset = 0usize;
    let mut ended = false;
    while offset.checked_add(BLOCK).is_some_and(|n| n <= raw.len()) {
        let header = &raw[offset..offset + BLOCK];
        offset += BLOCK;
        if header.iter().all(|byte| *byte == 0) {
            if offset + BLOCK > raw.len()
                || raw[offset..offset + BLOCK].iter().any(|byte| *byte != 0)
            {
                return Err("tar must end with two zero blocks".into());
            }
            if raw[offset + BLOCK..].iter().any(|byte| *byte != 0) {
                return Err("non-canonical bytes after tar end".into());
            }
            ended = true;
            break;
        }
        let stored = octal(&header[148..156])?;
        let checksum: u64 = header
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                if (148..156).contains(&index) {
                    32
                } else {
                    u64::from(*byte)
                }
            })
            .sum();
        if stored != checksum {
            return Err("tar header checksum mismatch".into());
        }
        if !header[257..263].iter().all(|b| *b == 0) && field_string(&header[257..263])? != "ustar"
        {
            return Err("unsupported tar format".into());
        }
        if !matches!(header[156], 0 | b'0') {
            return Err("tar contains a link or non-regular entry".into());
        }
        if header[157..257].iter().any(|b| *b != 0) {
            return Err("tar link target is not permitted".into());
        }
        let name = field_string(&header[0..100])?;
        let prefix = field_string(&header[345..500])?;
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_empty() || !crate::contract::safe_relative_path(&path) {
            return Err("unsafe tar path".into());
        }
        if files.contains_key(&path) {
            return Err("duplicate tar path".into());
        }
        let size =
            usize::try_from(octal(&header[124..136])?).map_err(|_| "tar entry is too large")?;
        if path == "manifest.json" && size > MAX_MANIFEST_BYTES {
            return Err("bundle manifest exceeds the size limit".into());
        }
        let padded = size
            .checked_add(BLOCK - 1)
            .ok_or("tar entry size overflow")?
            / BLOCK
            * BLOCK;
        let end = offset.checked_add(padded).ok_or("tar offset overflow")?;
        if end > raw.len() {
            return Err("truncated tar entry".into());
        }
        if raw[offset + size..end].iter().any(|byte| *byte != 0) {
            return Err("tar entry has non-zero padding".into());
        }
        files.insert(path, raw[offset..offset + size].to_vec());
        offset = end;
        if files.len() > crate::contract::MAX_BUNDLE_ENTRIES + 1 {
            return Err("tar contains too many entries".into());
        }
    }
    if !ended {
        return Err("tar end marker is missing".into());
    }
    let manifest_bytes = files
        .remove("manifest.json")
        .ok_or("bundle manifest is missing")?;
    Ok((files, manifest_bytes))
}

fn write_octal(header: &mut [u8], start: usize, len: usize, value: u64) -> Result<(), String> {
    let text = format!("{value:0width$o}\0", width = len - 1);
    if text.len() > len {
        return Err("tar numeric field does not fit".into());
    }
    header[start..start + text.len()].copy_from_slice(text.as_bytes());
    Ok(())
}

fn append_tar_file(out: &mut Vec<u8>, path: &str, content: &[u8]) -> Result<(), String> {
    let mut name = path.as_bytes();
    let mut prefix = &[][..];
    if name.len() > 100 {
        let split = path.rfind('/').ok_or("tar path is too long")?;
        prefix = &path.as_bytes()[..split];
        name = &path.as_bytes()[split + 1..];
        if name.len() > 100 || prefix.len() > 155 {
            return Err("tar path is too long".into());
        }
    }
    let mut header = [0u8; BLOCK];
    header[..name.len()].copy_from_slice(name);
    header[345..345 + prefix.len()].copy_from_slice(prefix);
    write_octal(&mut header, 100, 8, 0o600)?;
    write_octal(&mut header, 108, 8, 0)?;
    write_octal(&mut header, 116, 8, 0)?;
    write_octal(&mut header, 124, 12, content.len() as u64)?;
    write_octal(&mut header, 136, 12, 0)?;
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let encoded = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(encoded.as_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(content);
    let padding = (BLOCK - content.len() % BLOCK) % BLOCK;
    out.resize(out.len() + padding, 0);
    Ok(())
}

fn checked_tar_size(content_lengths: impl IntoIterator<Item = usize>) -> Option<usize> {
    content_lengths
        .into_iter()
        .try_fold(BLOCK * 2, |total, size| {
            let padded = size.checked_add(BLOCK - 1)? / BLOCK * BLOCK;
            total.checked_add(BLOCK)?.checked_add(padded)
        })
}

pub fn write_bundle_tar(
    manifest: &BundleManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, String> {
    validate_manifest(manifest, files)?;
    let manifest_bytes =
        serde_json::to_vec(manifest).map_err(|e| format!("serialise bundle manifest: {e}"))?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err("bundle manifest exceeds the size limit".into());
    }
    let total_size =
        checked_tar_size(std::iter::once(manifest_bytes.len()).chain(files.values().map(Vec::len)))
            .filter(|size| *size <= max_bytes(manifest.kind))
            .ok_or("bundle exceeds the size limit")?;
    let mut tar = Vec::new();
    tar.try_reserve_exact(total_size)
        .map_err(|_| "cannot allocate bounded bundle archive")?;
    append_tar_file(&mut tar, "manifest.json", &manifest_bytes)?;
    for (path, content) in files {
        append_tar_file(&mut tar, path, content)?;
    }
    tar.resize(tar.len() + BLOCK * 2, 0);
    debug_assert_eq!(tar.len(), total_size);
    Ok(tar)
}

pub fn parse_bundle_tar(raw: &[u8], expected_kind: Option<BundleKind>) -> Result<Bundle, String> {
    let (files, manifest_bytes) = parse_tar(
        raw,
        expected_kind.map(max_bytes).unwrap_or(MAX_OUTBOX_BYTES),
    )?;
    let manifest: BundleManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "invalid bundle manifest")?;
    if expected_kind.is_some_and(|expected| manifest.kind != expected) {
        return Err("bundle kind does not match the requested operation".into());
    }
    validate_manifest(&manifest, &files)?;
    Ok(Bundle {
        manifest,
        files,
        tar_bytes: raw.to_vec(),
    })
}

pub fn encrypt_bundle_tar(
    tar: &[u8],
    passphrase: &str,
    expected_kind: BundleKind,
) -> Result<Vec<u8>, String> {
    parse_bundle_tar(tar, Some(expected_kind))?;
    let secret = SecretString::from(passphrase.to_owned());
    let encryptor = Encryptor::with_user_passphrase(secret);
    let mut ciphertext = Vec::new();
    {
        let mut writer = encryptor
            .wrap_output(&mut ciphertext)
            .map_err(|_| "age encryption setup failed")?;
        writer
            .write_all(tar)
            .map_err(|_| "age encryption write failed")?;
        writer
            .finish()
            .map_err(|_| "age encryption finalisation failed")?;
    }
    if ciphertext.len() > max_bytes(expected_kind) {
        return Err("encrypted bundle exceeds the size limit".into());
    }
    Ok(ciphertext)
}

pub fn decrypt_bundle(
    ciphertext: &[u8],
    passphrase: &str,
    expected_kind: BundleKind,
) -> Result<Bundle, String> {
    let limit = max_bytes(expected_kind);
    if ciphertext.is_empty() || ciphertext.len() > limit {
        return Err("encrypted bundle exceeds the size limit".into());
    }
    let decryptor = Decryptor::new(ciphertext).map_err(|_| "invalid age bundle")?;
    if !decryptor.is_scrypt() {
        return Err("bundle must use one age scrypt recipient".into());
    }
    let mut identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    identity.set_max_work_factor(20);
    let reader = decryptor
        .decrypt(iter::once(&identity as &dyn age::Identity))
        .map_err(|_| "bundle authentication failed")?;
    let mut tar = Vec::with_capacity(ciphertext.len().min(limit));
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut tar)
        .map_err(|_| "bundle authentication failed")?;
    if tar.len() > limit {
        return Err("bundle exceeds the size limit".into());
    }
    parse_bundle_tar(&tar, Some(expected_kind))
}

fn bundle_path(directory: &Path, sequence: u64) -> PathBuf {
    directory.join(format!("bundle-{sequence}.age"))
}

pub fn bundle_sequence_from_filename(path: &Path) -> Result<u64, String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid bundle filename")?;
    let sequence_text = filename
        .strip_prefix("bundle-")
        .and_then(|s| s.strip_suffix(".age"))
        .ok_or("bundle filename does not match the exchange format")?;
    if sequence_text.is_empty() || !sequence_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("non-canonical bundle filename sequence".into());
    }
    let sequence = sequence_text
        .parse::<u64>()
        .map_err(|_| "invalid bundle filename sequence")?;
    if sequence_text.len() > 1 && sequence_text.starts_with('0') {
        return Err("non-canonical bundle filename sequence".into());
    }
    if sequence == 0 || sequence > crate::contract::MAX_SAFE_SEQUENCE {
        return Err("bundle filename sequence is out of range".into());
    }
    Ok(sequence)
}

pub fn validate_bundle_filename_sequence(
    path: &Path,
    manifest_sequence: u64,
) -> Result<(), String> {
    if bundle_sequence_from_filename(path)? != manifest_sequence {
        return Err("bundle filename sequence does not match its authenticated manifest".into());
    }
    Ok(())
}

/// Reads a completed exchange bundle and binds its filename to the authenticated sequence.
pub fn read_bundle_file(
    path: &Path,
    passphrase: &str,
    expected_kind: BundleKind,
) -> Result<Bundle, String> {
    bundle_sequence_from_filename(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect bundle: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("bundle path must be a regular non-symlink file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("cannot safely open bundle: {e}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|e| format!("cannot inspect opened bundle: {e}"))?;
    let maximum = max_bytes(expected_kind);
    #[cfg(unix)]
    let is_reparse = opened_metadata.file_type().is_symlink();
    #[cfg(windows)]
    let is_reparse = {
        use std::os::windows::fs::MetadataExt;
        opened_metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(any(unix, windows)))]
    let is_reparse = false;
    if is_reparse || !opened_metadata.is_file() || opened_metadata.len() > maximum as u64 {
        return Err("bundle file is not regular or exceeds its size limit".into());
    }
    let mut ciphertext = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut ciphertext)
        .map_err(|e| format!("cannot read bundle: {e}"))?;
    if ciphertext.len() > maximum {
        return Err("bundle file exceeds its size limit".into());
    }
    let bundle = decrypt_bundle(&ciphertext, passphrase, expected_kind)?;
    validate_bundle_filename_sequence(path, bundle.manifest.seq)?;
    Ok(bundle)
}

/// Publishes one immutable tar snapshot with a reserved sequence. The caller
/// reserves `manifest.seq` before calling. A cross-process directory lock spans
/// publication and pruning. The encrypted file is flushed, atomically renamed,
/// authenticated on readback, then older authenticated
/// completed files are pruned. Partial files are never counted.
pub fn write_bundle_file(
    directory: &Path,
    manifest: &BundleManifest,
    files: &BTreeMap<String, Vec<u8>>,
    passphrase: &str,
) -> Result<PathBuf, String> {
    let operation_lock = acquire_bundle_operation_lock(directory)?;
    write_bundle_file_locked(&operation_lock, directory, manifest, files, passphrase)
}

/// Publishes under a lock already acquired before sequence reservation.
pub fn write_bundle_file_locked(
    operation_lock: &BundleOperationLock,
    directory: &Path,
    manifest: &BundleManifest,
    files: &BTreeMap<String, Vec<u8>>,
    passphrase: &str,
) -> Result<PathBuf, String> {
    if operation_lock.directory != directory {
        return Err("bundle operation lock belongs to a different directory".into());
    }
    let tar = write_bundle_tar(manifest, files)?;
    let destination = bundle_path(directory, manifest.seq);
    let temporary = directory.join(format!(".bundle-{}.age.tmp", manifest.seq));
    if destination.exists() {
        return Err("reserved bundle sequence already has a completed file".into());
    }
    let mut created_temporary = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("cannot create bundle temporary file: {e}"))?;
        created_temporary = true;
        let ciphertext = encrypt_bundle_tar(&tar, passphrase, manifest.kind)?;
        file.write_all(&ciphertext)
            .map_err(|e| format!("cannot write encrypted bundle: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("cannot flush encrypted bundle: {e}"))?;
        drop(file);
        match fs::symlink_metadata(&destination) {
            Ok(_) => return Err("reserved bundle sequence already has a completed file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect bundle destination: {error}")),
        }
        fs::rename(&temporary, &destination)
            .map_err(|e| format!("cannot publish encrypted bundle: {e}"))?;
        created_temporary = false;
        if let Err(error) = sync_directory(directory) {
            let _ = fs::remove_file(&destination);
            let _ = sync_directory(directory);
            return Err(error);
        }
        let readback = match read_bundle_file(&destination, passphrase, manifest.kind) {
            Ok(bundle) => bundle,
            Err(error) => {
                let _ = fs::remove_file(&destination);
                let _ = sync_directory(directory);
                return Err(error);
            }
        };
        if readback.tar_bytes != tar {
            let _ = fs::remove_file(&destination);
            let _ = sync_directory(directory);
            return Err("published bundle readback differs from the immutable snapshot".into());
        }
        prune_older_bundles(directory, manifest.seq, passphrase, manifest.kind)?;
        sync_directory(directory)?;
        Ok(destination.clone())
    })();
    if result.is_err() && created_temporary {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn lock_bundle_directory(directory: &Path) -> Result<File, String> {
    use fs2::FileExt;
    let lock_path = directory.join(".bundle-operation.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
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
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(&lock_path)
        .map_err(|e| format!("cannot open bundle operation lock: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("cannot inspect bundle operation lock: {e}"))?;
    #[cfg(windows)]
    let is_reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let is_reparse = false;
    if is_reparse || !metadata.is_file() {
        return Err("bundle operation lock is not a regular file".into());
    }
    file.try_lock_exclusive()
        .map_err(|e| format!("cannot acquire bundle operation lock: {e}"))?;
    Ok(file)
}

fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("cannot sync bundle directory: {e}"))?;
    }
    Ok(())
}

fn prune_older_bundles(
    directory: &Path,
    keep_sequence: u64,
    passphrase: &str,
    kind: BundleKind,
) -> Result<(), String> {
    let entries =
        fs::read_dir(directory).map_err(|e| format!("cannot enumerate bundle directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot enumerate bundle directory: {e}"))?;
        let path = entry.path();
        let filename = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let number = match filename
            .strip_prefix("bundle-")
            .and_then(|s| s.strip_suffix(".age"))
        {
            Some(n) => n,
            None => continue,
        };
        let sequence = match number.parse::<u64>() {
            Ok(n) if n < keep_sequence => n,
            _ => continue,
        };
        if number.is_empty() || (number.len() > 1 && number.starts_with('0')) {
            continue;
        }
        if read_bundle_file(&path, passphrase, kind)
            .is_ok_and(|bundle| bundle.manifest.seq == sequence)
        {
            fs::remove_file(path).map_err(|e| format!("cannot prune old bundle: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{BundleEntry, PathClass, sha256_hex};

    fn sample() -> (BundleManifest, BTreeMap<String, Vec<u8>>) {
        let path = ".claude/settings.json".to_owned();
        let bytes = b"{\"theme\":\"synthetic\"}\n".to_vec();
        let manifest = BundleManifest {
            version: 1,
            seq: 17,
            created_at: "2026-10-19T00:00:00Z".into(),
            kind: BundleKind::Inbox,
            entries: vec![BundleEntry {
                path: path.clone(),
                class: PathClass::ConfigSettings,
                sha256: sha256_hex(&bytes),
                size: bytes.len() as u64,
            }],
            last_inbox_seq: None,
            truncated: None,
            skipped_symlinks: None,
        };
        (manifest, BTreeMap::from([(path, bytes)]))
    }

    #[test]
    fn tar_round_trip_preserves_the_b_wire_paths() {
        let (manifest, files) = sample();
        let tar = write_bundle_tar(&manifest, &files).unwrap();
        let parsed = parse_bundle_tar(&tar, Some(BundleKind::Inbox)).unwrap();
        assert_eq!(parsed.manifest, manifest);
        assert_eq!(parsed.files, files);
    }

    #[test]
    fn aggregate_archive_size_is_checked_before_allocation() {
        let cap = max_bytes(BundleKind::Inbox);
        let one_large_entry = cap / 2 + BLOCK;
        assert!(checked_tar_size([one_large_entry, one_large_entry]).unwrap() > cap);
        assert!(checked_tar_size([usize::MAX]).is_none());
    }

    #[test]
    fn age_round_trip_uses_default_scrypt_cost() {
        let (manifest, files) = sample();
        let tar = write_bundle_tar(&manifest, &files).unwrap();
        let cipher = encrypt_bundle_tar(
            &tar,
            "SYNTHETIC_FIXTURE_passphrase_for_bundle",
            BundleKind::Inbox,
        )
        .unwrap();
        assert_eq!(
            decrypt_bundle(
                &cipher,
                "SYNTHETIC_FIXTURE_passphrase_for_bundle",
                BundleKind::Inbox
            )
            .unwrap()
            .tar_bytes,
            tar
        );
        assert!(
            decrypt_bundle(
                &cipher,
                "SYNTHETIC_FIXTURE_wrong_passphrase",
                BundleKind::Inbox
            )
            .is_err()
        );
        let mut corrupt = cipher.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(
            decrypt_bundle(
                &corrupt,
                "SYNTHETIC_FIXTURE_passphrase_for_bundle",
                BundleKind::Inbox
            )
            .is_err()
        );

        let mut excessive = cipher;
        let marker = b"-> scrypt ";
        let stanza = excessive
            .windows(marker.len())
            .position(|window| window == marker)
            .unwrap()
            + marker.len();
        let salt_end = excessive[stanza..]
            .iter()
            .position(|byte| *byte == b' ')
            .unwrap()
            + stanza;
        let factor_start = salt_end + 1;
        let factor_end = excessive[factor_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap()
            + factor_start;
        excessive.splice(factor_start..factor_end, b"63".iter().copied());
        assert!(
            decrypt_bundle(
                &excessive,
                "SYNTHETIC_FIXTURE_passphrase_for_bundle",
                BundleKind::Inbox
            )
            .is_err()
        );
    }

    #[test]
    fn publication_preserves_existing_files_and_interrupted_temporaries() {
        use std::sync::{Arc, Barrier};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ais-rust-bundle-SYNTHETIC_FIXTURE-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let (manifest, files) = sample();
        let destination = bundle_path(&directory, manifest.seq);
        let temporary = directory.join(format!(".bundle-{}.age.tmp", manifest.seq));
        let old_ciphertext = b"SYNTHETIC_FIXTURE_existing-completed-ciphertext";
        fs::write(&destination, old_ciphertext).unwrap();
        assert!(
            write_bundle_file(
                &directory,
                &manifest,
                &files,
                "SYNTHETIC_FIXTURE_passphrase_for_bundle"
            )
            .is_err()
        );
        assert_eq!(fs::read(&destination).unwrap(), old_ciphertext);

        fs::remove_file(&destination).unwrap();
        let partial = b"SYNTHETIC_FIXTURE_interrupted-temporary";
        fs::write(&temporary, partial).unwrap();
        assert!(
            write_bundle_file(
                &directory,
                &manifest,
                &files,
                "SYNTHETIC_FIXTURE_passphrase_for_bundle"
            )
            .is_err()
        );
        assert_eq!(fs::read(&temporary).unwrap(), partial);
        fs::remove_file(&temporary).unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let barrier = Arc::clone(&barrier);
            let directory = directory.clone();
            let manifest = manifest.clone();
            let files = files.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                write_bundle_file(
                    &directory,
                    &manifest,
                    &files,
                    "SYNTHETIC_FIXTURE_passphrase_for_bundle",
                )
            }));
        }
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let readback = read_bundle_file(
            &destination,
            "SYNTHETIC_FIXTURE_passphrase_for_bundle",
            BundleKind::Inbox,
        )
        .unwrap();
        assert_eq!(readback.manifest, manifest);
        fs::remove_dir_all(directory).unwrap();
    }

    fn recalculate_checksum(header: &mut [u8]) {
        header[148..156].fill(b' ');
        let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
        header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    }

    #[test]
    fn tar_parser_rejects_links_devices_traversal_absolute_and_duplicates() {
        let (manifest, files) = sample();
        let tar = write_bundle_tar(&manifest, &files).unwrap();
        let manifest_size = serde_json::to_vec(&manifest).unwrap().len();
        let second_header = BLOCK + manifest_size.div_ceil(BLOCK) * BLOCK;

        for typeflag in *b"123456" {
            let mut altered = tar.clone();
            altered[second_header + 156] = typeflag;
            recalculate_checksum(&mut altered[second_header..second_header + BLOCK]);
            assert!(parse_bundle_tar(&altered, Some(BundleKind::Inbox)).is_err());
        }
        for name in [b"../escape".as_slice(), b"/absolute", b"C:/drive"] {
            let mut altered = tar.clone();
            altered[second_header..second_header + 100].fill(0);
            altered[second_header..second_header + name.len()].copy_from_slice(name);
            recalculate_checksum(&mut altered[second_header..second_header + BLOCK]);
            assert!(parse_bundle_tar(&altered, Some(BundleKind::Inbox)).is_err());
        }
        let mut duplicate = tar;
        duplicate[second_header..second_header + 100].fill(0);
        duplicate[second_header..second_header + b"manifest.json".len()]
            .copy_from_slice(b"manifest.json");
        recalculate_checksum(&mut duplicate[second_header..second_header + BLOCK]);
        assert!(parse_bundle_tar(&duplicate, Some(BundleKind::Inbox)).is_err());
    }
}
