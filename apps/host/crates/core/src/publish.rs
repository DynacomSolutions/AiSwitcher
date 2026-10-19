//! Writes the first encrypted inbox and the optional model onto a mounted
//! exchange directory and reads both back before the drive may be called ready.
//! The directory is whatever the operating system mounted for the exchange
//! partition; no filesystem driver or privileged access is involved.
use crate::{
    bundle::{read_bundle_file, write_bundle_file},
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

pub fn publish_first_inbox(
    exchange: &Path,
    snapshot: &SourceSnapshot,
    passphrase: &str,
) -> Result<PathBuf, String> {
    let mut manifest = snapshot.bundle.manifest.clone();
    manifest.seq = FIRST_INBOX_SEQUENCE;
    manifest.kind = BundleKind::Inbox;
    write_bundle_file(exchange, &manifest, &snapshot.bundle.files, passphrase)
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
    Ok(destination)
}

/// Readback: the inbox decrypts with the passphrase and has the expected
/// sequence, and a published model matches its pin byte for byte.
pub fn verify_published(
    exchange: &Path,
    passphrase: &str,
    model: Option<&crate::create::ModelEntry>,
) -> Result<(), String> {
    let inbox = exchange.join(format!("bundle-{FIRST_INBOX_SEQUENCE}.age"));
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
