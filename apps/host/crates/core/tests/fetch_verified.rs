#![cfg(feature = "file-test")]
use ais_host_core::{
    fetch::{FetchError, Http, fetch_verified, fetch_verified_tag},
    file_test::SyntheticRelease,
    release::ImageVerifier,
};
use std::{collections::BTreeMap, io::Write};

const LISTING: &str = "https://api.github.com/repos/o/r/releases";

struct Fake(BTreeMap<String, Vec<u8>>);

impl Http for Fake {
    fn get(&self, url: &str, limit: u64, out: &mut dyn Write) -> Result<(), FetchError> {
        let body = self.0.get(url).ok_or(FetchError::Network)?;
        if body.len() as u64 > limit {
            return Err(FetchError::Size);
        }
        out.write_all(body).map_err(|_| FetchError::Network)
    }
}

#[test]
fn resume_fetches_only_the_recorded_tag_and_reverifies_digest_and_signature() {
    let release = SyntheticRelease::new(vec![0x53; 512]);
    let mut http = serve(&release, release.sums.clone());
    let listing: serde_json::Value =
        serde_json::from_slice(&http.0.remove(LISTING).unwrap()).unwrap();
    let url = format!(
        "https://api.github.com/repos/DynacomSolutions/AiSwitcher/releases/tags/{}",
        release.selection.tag()
    );
    http.0
        .insert(url.clone(), serde_json::to_vec(&listing[0]).unwrap());
    let verifier = ImageVerifier::synthetic(&release.public_key, &release.raw).unwrap();
    let digest = ais_host_core::release::sha256(&release.raw);
    let fetched =
        fetch_verified_tag(&http, &verifier, release.selection.tag(), digest, &base()).unwrap();
    assert_eq!(fetched.image.digest(), digest);
    assert!(matches!(
        fetch_verified_tag(&http, &verifier, release.selection.tag(), [0; 32], &base()),
        Err(FetchError::JournalMismatch)
    ));
    // A different valid signing key is still refused on recovery.
    let other = SyntheticRelease::new(vec![0x53; 512]);
    let wrong_key = ImageVerifier::synthetic(&other.public_key, &release.raw).unwrap();
    assert!(
        fetch_verified_tag(&http, &wrong_key, release.selection.tag(), digest, &base()).is_err()
    );
    let signature_url = "https://github.com/o/r/releases/download/x/3";
    let signature = http.0.get_mut(signature_url).unwrap();
    // The first line is an unsigned comment. Alter the encoded signature.
    let offset = signature.iter().position(|byte| *byte == b'\n').unwrap() + 21;
    signature[offset] = if signature[offset] == b'A' {
        b'B'
    } else {
        b'A'
    };
    assert!(
        fetch_verified_tag(&http, &verifier, release.selection.tag(), digest, &base()).is_err()
    );
    http.0.remove(&url);
    assert!(
        matches!(
            fetch_verified_tag(&http, &verifier, release.selection.tag(), digest, &base()),
            Err(FetchError::Network)
        ),
        "no fallback when the recorded release is unavailable"
    );
}

fn serve(release: &SyntheticRelease, sums: Vec<u8>) -> Fake {
    let url = |id: u64| format!("https://github.com/o/r/releases/download/x/{id}");
    let assets = [
        (release.selection.image(), release.compressed.clone()),
        (release.selection.sums(), sums),
        (release.selection.signature(), release.signature.clone()),
    ];
    let listing = serde_json::json!([{
        "id": 1, "tag_name": release.selection.tag(), "draft": false, "prerelease": false,
        "published_at": "2026-10-01T00:00:00Z",
        "assets": assets.iter().map(|(asset, _)| serde_json::json!({
            "id": asset.id, "name": asset.name, "size": asset.size,
            "updated_at": asset.revision, "browser_download_url": url(asset.id),
        })).collect::<Vec<_>>(),
    }]);
    let mut files = BTreeMap::new();
    files.insert(LISTING.to_string(), listing.to_string().into_bytes());
    for (asset, bytes) in assets {
        files.insert(url(asset.id), bytes);
    }
    Fake(files)
}

fn base() -> std::path::PathBuf {
    std::env::temp_dir()
}

#[test]
fn a_signed_release_is_downloaded_verified_and_retained() {
    let release = SyntheticRelease::new(vec![0x53; 512]);
    let http = serve(&release, release.sums.clone());
    let verifier = ImageVerifier::synthetic(&release.public_key, &release.raw).unwrap();
    let fetched = fetch_verified(&http, &verifier, LISTING, &base()).unwrap();
    assert_eq!(fetched.release.tag, release.selection.tag());
    assert_eq!(fetched.image.len(), 512);
    let sizes: Vec<u64> = fetched
        .sources
        .iter()
        .map(|f| f.metadata().unwrap().len())
        .collect();
    assert_eq!(sizes[0], release.compressed.len() as u64);
}

#[test]
fn altered_checksums_are_fatal() {
    let release = SyntheticRelease::new(vec![0x53; 512]);
    let mut sums = release.sums.clone();
    sums[0] ^= 1;
    let http = serve(&release, sums);
    let verifier = ImageVerifier::synthetic(&release.public_key, &release.raw).unwrap();
    assert!(fetch_verified(&http, &verifier, LISTING, &base()).is_err());
}

#[test]
fn the_bundled_production_key_decodes() {
    assert!(ImageVerifier::bundled().is_ok());
}

#[test]
fn unapproved_listing_addresses_are_never_requested() {
    let http = Fake(BTreeMap::new());
    let verifier = ImageVerifier::synthetic(
        &SyntheticRelease::new(vec![0x53; 512]).public_key,
        &[0; 512],
    )
    .unwrap();
    assert!(matches!(
        fetch_verified(&http, &verifier, "http://github.com/x", &base()),
        Err(FetchError::Address)
    ));
}
