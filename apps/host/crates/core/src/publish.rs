//! Writes the first encrypted inbox and the optional model onto a mounted
//! exchange directory and reads both back before the drive may be called ready.
//! The directory is whatever the operating system mounted for the exchange
//! partition; no filesystem driver or privileged access is involved.
use crate::{
    bundle::{encrypt_bundle_tar, read_bundle_file, write_bundle_tar},
    contract::BundleKind,
    flow_adapter::SourceSnapshot,
    model::{VerifiedModel, free_bytes},
    release::{hex, sha256_reader},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, Write},
    path::{Path, PathBuf},
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
    pub fn publish(&self, exchange: &Path) -> Result<PathBuf, String> {
        let directory = exchange.join("inbox");
        fs::create_dir_all(&directory).map_err(|_| "cannot create the inbox directory")?;
        let destination = directory.join("bundle-1.age");
        let temporary = directory.join(".bundle-1.age.tmp");
        if fs::symlink_metadata(&destination).is_ok() {
            return Err("The first inbox already exists.".into());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "cannot create the first inbox")?;
        file.write_all(&self.0)
            .and_then(|_| file.sync_all())
            .map_err(|_| "cannot flush the first inbox")?;
        drop(file);
        fs::rename(&temporary, &destination).map_err(|_| "cannot publish the first inbox")?;
        sync_directory(&directory)?;
        sync_directory(exchange)?;
        let readback = fs::read(&destination).map_err(|_| "cannot read the first inbox")?;
        if readback != self.0 {
            return Err("The first inbox failed readback verification.".into());
        }
        Ok(destination)
    }
}

pub fn publish_first_inbox(
    exchange: &Path,
    snapshot: &SourceSnapshot,
    passphrase: &str,
) -> Result<PathBuf, String> {
    prepare_first_inbox(snapshot, passphrase)?.publish(exchange)
}

pub fn verify_model_source(model: &mut VerifiedModel) -> Result<(), String> {
    model.file.rewind().map_err(|_| "cannot read the model")?;
    if !model
        .file
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() == model.entry.size_bytes)
        || hex(&sha256_reader(&mut model.file).map_err(|_| "cannot read the model")?)
            != model.entry.sha256
    {
        return Err("The selected model no longer matches its pin.".into());
    }
    Ok(())
}

/// Copy the verified model to `models/<file>` through a temporary name and an
/// atomic rename, then hash the published copy against the pin.
pub fn publish_model(exchange: &Path, model: &mut VerifiedModel) -> Result<PathBuf, String> {
    if free_bytes(exchange).is_some_and(|free| free < model.entry.size_bytes) {
        return Err("The exchange partition has too little free space for the model.".into());
    }
    let directory = exchange.join("models");
    fs::create_dir_all(&directory).map_err(|_| "cannot create the model directory")?;
    let destination = directory.join(&model.entry.file);
    let temporary = directory.join(format!(".{}.tmp", model.entry.file));
    let _ = fs::remove_file(&temporary);
    let result = (|| -> Result<(), String> {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "cannot create the model file")?;
        model.file.rewind().map_err(|_| "cannot read the model")?;
        std::io::copy(&mut model.file, &mut out).map_err(|_| "cannot write the model")?;
        out.flush().map_err(|_| "cannot write the model")?;
        out.sync_all().map_err(|_| "cannot flush the model")?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, &destination).map_err(|_| "cannot publish the model")?;
    sync_directory(&directory)?;
    sync_directory(exchange)?;
    Ok(destination)
}

fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| "cannot flush the exchange directory")?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

/// Readback: the inbox decrypts with the passphrase and has the expected
/// sequence, and a published model matches its pin byte for byte.
pub fn verify_published(
    exchange: &Path,
    passphrase: &str,
    model: Option<&crate::create::ModelEntry>,
) -> Result<(), String> {
    let inbox = exchange
        .join("inbox")
        .join(format!("bundle-{FIRST_INBOX_SEQUENCE}.age"));
    let bundle = read_bundle_file(&inbox, passphrase, BundleKind::Inbox)?;
    if bundle.manifest.seq != FIRST_INBOX_SEQUENCE {
        return Err("The published inbox has an unexpected sequence.".into());
    }
    if let Some(entry) = model {
        let path = exchange.join("models").join(&entry.file);
        let mut file = File::open(&path).map_err(|_| "The published model is missing.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "The published model is unreadable.")?;
        if !metadata.is_file() || metadata.len() != entry.size_bytes {
            return Err("The published model has the wrong size.".into());
        }
        let digest = sha256_reader(&mut file).map_err(|_| "The published model is unreadable.")?;
        if hex(&digest) != entry.sha256 {
            return Err("The published model does not match its pin.".into());
        }
    }
    Ok(())
}
