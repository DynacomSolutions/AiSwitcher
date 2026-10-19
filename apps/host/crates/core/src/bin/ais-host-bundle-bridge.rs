//! Development-only bridge for deterministic Rust/B bundle interoperability checks.
//!
//! The file is compiled as a `file-test`-gated binary by the workspace manifest.

use ais_host_core::{
    bundle::{decrypt_bundle, encrypt_bundle_tar, parse_bundle_tar, write_bundle_tar},
    contract::{BundleKind, classify_path},
};
use std::{env, fs, io::Read, path::Path};

fn kind(value: &str) -> Result<BundleKind, String> {
    match value {
        "inbox" => Ok(BundleKind::Inbox),
        "outbox" => Ok(BundleKind::Outbox),
        _ => Err("kind must be inbox or outbox".into()),
    }
}

fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("cannot stat input: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max as u64 {
        return Err("input exceeds the bundle size limit".into());
    }
    let file = fs::File::open(path).map_err(|e| format!("cannot open input: {e}"))?;
    let opened = file
        .metadata()
        .map_err(|e| format!("cannot inspect input: {e}"))?;
    if !opened.is_file() || opened.len() > max as u64 {
        return Err("input exceeds the bundle size limit".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read input: {e}"))?;
    if bytes.len() > max {
        return Err("input exceeds the bundle size limit".into());
    }
    Ok(bytes)
}

fn run(args: &[String]) -> Result<(), String> {
    if args.first().is_some_and(|mode| mode == "classify") {
        if args.len() != 3 {
            return Err(
                "usage: ais-host-bundle-bridge classify <paths.json> <classes.json>".into(),
            );
        }
        let input = read_bounded(Path::new(&args[1]), 1024 * 1024)?;
        let paths: Vec<String> = serde_json::from_slice(&input)
            .map_err(|_| "paths input must be a JSON string array")?;
        if paths.len() > 10_000 {
            return Err("too many paths to classify".into());
        }
        let classes = paths
            .iter()
            .map(|path| classify_path(path))
            .collect::<Vec<_>>();
        let output_bytes =
            serde_json::to_vec(&classes).map_err(|e| format!("cannot encode classes: {e}"))?;
        fs::write(Path::new(&args[2]), output_bytes)
            .map_err(|e| format!("cannot write classes output: {e}"))?;
        return Ok(());
    }
    if args.len() != 5 {
        return Err("usage: ais-host-bundle-bridge <write|repack|read> <input> <output> <passphrase-file> <inbox|outbox>".into());
    }
    let mode = &args[0];
    let input = Path::new(&args[1]);
    let output = Path::new(&args[2]);
    let passphrase_path = Path::new(&args[3]);
    let bundle_kind = kind(&args[4])?;
    let passphrase = String::from_utf8(read_bounded(passphrase_path, 4096)?)
        .map_err(|_| "passphrase file must contain UTF-8")?;

    let bytes = match (mode.as_str(), bundle_kind) {
        ("write", BundleKind::Inbox)
        | ("repack", BundleKind::Inbox)
        | ("read", BundleKind::Inbox) => read_bounded(input, 64 * 1024 * 1024)?,
        ("write", BundleKind::Outbox)
        | ("repack", BundleKind::Outbox)
        | ("read", BundleKind::Outbox) => read_bounded(input, 32 * 1024 * 1024)?,
        _ => return Err("mode must be write or read".into()),
    };
    let result = match mode.as_str() {
        "write" => {
            parse_bundle_tar(&bytes, Some(bundle_kind))?;
            encrypt_bundle_tar(&bytes, &passphrase, bundle_kind)?
        }
        "repack" => {
            let bundle = parse_bundle_tar(&bytes, Some(bundle_kind))?;
            let rust_tar = write_bundle_tar(&bundle.manifest, &bundle.files)?;
            encrypt_bundle_tar(&rust_tar, &passphrase, bundle_kind)?
        }
        "read" => decrypt_bundle(&bytes, &passphrase, bundle_kind)?.tar_bytes,
        _ => return Err("mode must be write, repack or read".into()),
    };
    let temporary = output.with_extension("ais-bundle-bridge.tmp");
    fs::write(&temporary, result).map_err(|e| format!("cannot write output: {e}"))?;
    fs::rename(&temporary, output).map_err(|e| format!("cannot publish output: {e}"))
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if let Err(error) = run(&args) {
        eprintln!("bundle bridge: {error}");
        std::process::exit(2);
    }
}
