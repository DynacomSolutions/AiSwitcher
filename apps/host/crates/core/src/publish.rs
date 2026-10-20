//! Writes the first encrypted inbox and the optional model onto a mounted
//! exchange directory and reads both back before the drive may be called ready.
//! The directory is whatever the operating system mounted for the exchange
//! partition; no filesystem driver or privileged access is involved.
use crate::{
    bundle::{decrypt_bundle, encrypt_bundle_tar, write_bundle_tar},
    contract::BundleKind,
    exchange_root::ExchangeRoot,
    flow_adapter::SourceSnapshot,
    model::VerifiedModel,
    release::{hex, sha256_reader},
};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    path::PathBuf,
};

/// The first inbox always carries sequence 1; the drive applies it once.
pub const FIRST_INBOX_SEQUENCE: u64 = 1;

/// Only ciphertext survives preparation. Source reading, validation and
/// encryption finish before the privileged image write is launched.
pub struct PreparedInbox(Vec<u8>);

pub fn prepare_first_inbox(
    snapshot: &SourceSnapshot,
    passphrase: &str,
) -> Result<PreparedInbox, String> {
    let mut manifest = snapshot.bundle.manifest.clone();
    manifest.seq = FIRST_INBOX_SEQUENCE;
    manifest.kind = BundleKind::Inbox;
    let mut tar = write_bundle_tar(&manifest, &snapshot.bundle.files)?;
    let encrypted = encrypt_bundle_tar(&tar, passphrase, BundleKind::Inbox);
    tar.fill(0);
    encrypted.map(PreparedInbox)
}

impl PreparedInbox {
    pub fn publish(&self, exchange: &ExchangeRoot) -> Result<PathBuf, String> {
        let directory = exchange.directory("inbox", true)?;
        publish_atomic(&directory, "bundle-1.age", |file| {
            file.write_all(&self.0)
                .and_then(|_| file.sync_all())
                .map_err(|_| "cannot flush the first inbox")?;
            file.rewind().map_err(|_| "cannot read the first inbox")?;
            let mut readback = Vec::new();
            file.take(self.0.len() as u64 + 1)
                .read_to_end(&mut readback)
                .map_err(|_| "cannot read the first inbox")?;
            if readback != self.0 {
                return Err("The first inbox failed readback verification.".into());
            }
            Ok(())
        })?;
        exchange.sync()?;
        Ok(directory.display_path("bundle-1.age"))
    }
}

pub fn publish_first_inbox(
    exchange: &ExchangeRoot,
    snapshot: &SourceSnapshot,
    passphrase: &str,
) -> Result<PathBuf, String> {
    prepare_first_inbox(snapshot, passphrase)?.publish(exchange)
}

pub fn verify_model_source(model: &mut VerifiedModel) -> Result<(), String> {
    verify_file(&mut model.file, &model.entry)
}

/// Neither this descriptor nor a writable mapping escapes this module.
pub struct ModelSnapshot {
    pub entry: crate::create::ModelEntry,
    file: File,
}

pub fn snapshot_model(model: &mut VerifiedModel) -> Result<ModelSnapshot, String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        // Anonymous private staging, sealed against writes and resize before hashing.
        let fd = unsafe {
            libc::memfd_create(
                c"ais-model-snapshot".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if fd < 0 {
            return Err("Cannot create the private model snapshot.".into());
        }
        // SAFETY: memfd_create returned a new descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        model.file.rewind().map_err(|_| "Cannot read the model.")?;
        let limit = model
            .entry
            .size_bytes
            .checked_add(1)
            .ok_or("Invalid model size.")?;
        let copied = std::io::copy(&mut (&mut model.file).take(limit), &mut file)
            .map_err(|_| "Cannot snapshot the model.")?;
        if copied != model.entry.size_bytes {
            return Err("The model size changed.".into());
        }
        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        // SAFETY: fcntl operates on our private descriptor.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
            return Err("Cannot make the model snapshot immutable.".into());
        }
        verify_file(&mut file, &model.entry)?;
        Ok(ModelSnapshot {
            entry: model.entry.clone(),
            file,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = model;
        Err("Immutable model snapshots are unavailable on this platform.".into())
    }
}

fn verify_file(file: &mut File, entry: &crate::create::ModelEntry) -> Result<(), String> {
    file.rewind().map_err(|_| "Cannot read the model.")?;
    let metadata = file.metadata().map_err(|_| "Cannot inspect the model.")?;
    if !metadata.is_file()
        || metadata.len() != entry.size_bytes
        || hex(&sha256_reader(
            &mut file.take(
                entry
                    .size_bytes
                    .checked_add(1)
                    .ok_or("Invalid model size.")?,
            ),
        )
        .map_err(|_| "Cannot read the model.")?)
            != entry.sha256
    {
        return Err("The model does not match its size and hash pin.".into());
    }
    Ok(())
}

/// Verify staged bytes before the final name becomes visible.
pub fn publish_model(
    exchange: &ExchangeRoot,
    model: &mut ModelSnapshot,
) -> Result<PathBuf, String> {
    publish_model_checked(exchange, model, |_| Ok(()))
}

fn publish_model_checked(
    exchange: &ExchangeRoot,
    model: &mut ModelSnapshot,
    before_verify: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<PathBuf, String> {
    if exchange.available_bytes()? < model.entry.size_bytes {
        return Err("The exchange partition has too little free space for the model.".into());
    }
    let directory = exchange.directory("models", true)?;
    publish_atomic(&directory, &model.entry.file, |out| {
        model.file.rewind().map_err(|_| "cannot read the model")?;
        let copied = std::io::copy(&mut (&mut model.file).take(model.entry.size_bytes), out)
            .map_err(|_| "cannot write the model")?;
        if copied != model.entry.size_bytes {
            return Err("The model snapshot was truncated.".into());
        }
        out.sync_all().map_err(|_| "cannot flush the model")?;
        before_verify(out)?;
        verify_file(out, &model.entry)
    })?;
    exchange.sync()?;
    Ok(directory.display_path(&model.entry.file))
}

fn publish_atomic(
    directory: &ExchangeRoot,
    name: &str,
    write_and_verify: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).map_err(|_| "Cannot create a publication nonce.")?;
    let temporary = format!(".ais-{}.partial", hex(&nonce));
    let mut file = directory.open_file(&temporary, true)?;
    let result = write_and_verify(&mut file).and_then(|_| directory.rename(&temporary, name));
    if result.is_err() {
        directory.remove(&temporary);
    }
    result
}

/// Readback: the inbox decrypts with the passphrase and has the expected
/// sequence, and a published model matches its pin byte for byte.
pub fn verify_published(
    exchange: &ExchangeRoot,
    passphrase: &str,
    model: Option<&crate::create::ModelEntry>,
) -> Result<(), String> {
    let mut ciphertext = Vec::new();
    exchange
        .directory("inbox", false)?
        .open_file("bundle-1.age", false)?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut ciphertext)
        .map_err(|_| "Cannot read the inbox.")?;
    let bundle = decrypt_bundle(&ciphertext, passphrase, BundleKind::Inbox)?;
    if bundle.manifest.seq != FIRST_INBOX_SEQUENCE {
        return Err("The published inbox has an unexpected sequence.".into());
    }
    if let Some(entry) = model {
        let mut file = exchange
            .directory("models", false)?
            .open_file(&entry.file, false)?;
        verify_file(&mut file, entry)?;
    }
    Ok(())
}

#[cfg(all(test, feature = "file-test", target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn model_snapshot_is_sealed_and_corrupt_or_partial_staging_is_removed() {
        use crate::{create::Catalogue, file_test::fresh_file, release::sha256};
        let (path, mut file) =
            fresh_file(&std::env::temp_dir(), "model-SYNTHETIC-FIXTURE").unwrap();
        let body = b"SYNTHETIC_FIXTURE model bytes";
        file.write_all(body).unwrap();
        let mut entry = Catalogue::parse(crate::create::BUNDLED_CATALOGUE)
            .unwrap()
            .models
            .remove(0);
        entry.file = "synthetic.gguf".into();
        entry.size_bytes = body.len() as u64;
        entry.sha256 = hex(&sha256(body));
        let mut source = VerifiedModel {
            entry,
            file,
            path: path.clone(),
        };
        let mut snapshot = snapshot_model(&mut source).unwrap();
        assert!(snapshot.file.write_all(b"x").is_err());
        assert!(snapshot.file.set_len(0).is_err());
        let directory = path.with_extension("exchange");
        std::fs::create_dir(&directory).unwrap();
        let root = ExchangeRoot::test_directory(&directory).unwrap();
        for failure in ["overwrite", "grow", "truncate", "write"] {
            let result = publish_model_checked(&root, &mut snapshot, |out| {
                match failure {
                    "overwrite" => {
                        out.rewind().unwrap();
                        out.write_all(b"x").unwrap();
                    }
                    "grow" => {
                        out.seek(std::io::SeekFrom::End(0)).unwrap();
                        out.write_all(b"x").unwrap();
                    }
                    "truncate" => out.set_len(0).unwrap(),
                    _ => return Err("SYNTHETIC_FIXTURE write failure".into()),
                }
                Ok(())
            });
            assert!(result.is_err(), "{failure}");
            assert_eq!(
                std::fs::read_dir(directory.join("models")).unwrap().count(),
                0,
                "{failure}"
            );
        }
        publish_model(&root, &mut snapshot).unwrap();
        assert_eq!(
            std::fs::read(directory.join("models/synthetic.gguf")).unwrap(),
            body
        );
        drop(root);
        std::fs::remove_dir_all(directory).unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
