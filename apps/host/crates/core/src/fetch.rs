//! Release discovery and download. Everything fetched here is untrusted until
//! `ImageVerifier::verify` accepts it; this module never decides trust.
use crate::release::{
    AssetIdentity, DownloadedImage, ImageVerifier, PublishedRelease, TrustError, VerifiedImage,
    select_release_candidates,
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
};
use thiserror::Error;

pub const REPOSITORY: &str = "DynacomSolutions/AiSwitcher";
const MAX_LISTING_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum FetchError {
    #[error("The release listing could not be read.")]
    Listing,
    #[error("The download address is not an approved HTTPS release host.")]
    Address,
    #[error("The network request failed.")]
    Network,
    #[error("A download exceeded its published size.")]
    Size,
    #[error("No compatible published release was found.")]
    NoRelease,
    #[error(
        "The interrupted release does not match the journal's tag and SHA-256. No image was written."
    )]
    JournalMismatch,
    #[error(transparent)]
    Trust(#[from] TrustError),
    #[error("Local file handling failed.")]
    Io(#[from] std::io::Error),
}

/// A bounded HTTPS GET. Implementations must refuse to read past `limit` bytes.
pub trait Http {
    fn get(&self, url: &str, limit: u64, out: &mut dyn Write) -> Result<(), FetchError>;
}

/// Production client: HTTPS only. Redirects are followed by hand, at most five
/// hops, and every hop must stay on the approved hosts for this client.
pub struct UreqHttp {
    agent: ureq::Agent,
    hosts: &'static [&'static str],
}

pub const RELEASE_HOSTS: &[&str] = &["github.com", "githubusercontent.com"];

impl Default for UreqHttp {
    fn default() -> Self {
        Self::for_hosts(RELEASE_HOSTS)
    }
}

impl UreqHttp {
    pub fn for_hosts(hosts: &'static [&'static str]) -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .timeout_connect(std::time::Duration::from_secs(15))
                .timeout_read(std::time::Duration::from_secs(60))
                .user_agent("ais-host")
                .build(),
            hosts,
        }
    }
}

fn redirect_target(current: &str, location: &str) -> Option<String> {
    if location.starts_with("https://") {
        return Some(location.to_owned());
    }
    let origin_end = current["https://".len()..]
        .find('/')
        .map_or(current.len(), |index| index + "https://".len());
    (location.starts_with('/') && !location.starts_with("//"))
        .then(|| format!("{}{location}", &current[..origin_end]))
}

impl Http for UreqHttp {
    fn get(&self, url: &str, limit: u64, out: &mut dyn Write) -> Result<(), FetchError> {
        let mut url = url.to_owned();
        for _ in 0..=5 {
            if !approved_address_on(&url, self.hosts) {
                return Err(FetchError::Address);
            }
            let response = self
                .agent
                .get(&url)
                .call()
                .map_err(|_| FetchError::Network)?;
            if matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
                let location = response.header("location").ok_or(FetchError::Network)?;
                url = redirect_target(&url, location).ok_or(FetchError::Address)?;
                continue;
            }
            let mut body = response.into_reader().take(limit + 1);
            let copied = std::io::copy(&mut body, out).map_err(|_| FetchError::Network)?;
            if copied > limit {
                return Err(FetchError::Size);
            }
            return Ok(());
        }
        Err(FetchError::Network)
    }
}

#[derive(Deserialize)]
struct ApiRelease {
    id: u64,
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Deserialize)]
struct ApiAsset {
    id: u64,
    name: String,
    size: u64,
    updated_at: String,
    browser_download_url: String,
}

pub struct Listing {
    pub releases: Vec<PublishedRelease>,
    urls: BTreeMap<u64, String>,
}

/// Only HTTPS addresses on the release hosts are ever requested.
pub fn approved_address(url: &str) -> bool {
    approved_address_on(url, RELEASE_HOSTS)
}

pub fn approved_address_on(url: &str, hosts: &[&str]) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
        && !host.contains(['@', ':'])
        && hosts
            .iter()
            .any(|apex| host == *apex || host.ends_with(&format!(".{apex}")))
}

pub fn parse_listing(json: &[u8]) -> Result<Listing, FetchError> {
    let raw: Vec<ApiRelease> = serde_json::from_slice(json).map_err(|_| FetchError::Listing)?;
    listing_from_releases(raw)
}

fn listing_from_releases(raw: Vec<ApiRelease>) -> Result<Listing, FetchError> {
    let mut releases = Vec::new();
    let mut urls = BTreeMap::new();
    for release in raw {
        let Some(published) = release.published_at.as_deref() else {
            continue;
        };
        let published_at = chrono::DateTime::parse_from_rfc3339(published)
            .ok()
            .and_then(|time| u64::try_from(time.timestamp()).ok())
            .ok_or(FetchError::Listing)?;
        let mut assets = Vec::new();
        for asset in release.assets {
            urls.insert(asset.id, asset.browser_download_url);
            assets.push(AssetIdentity {
                id: asset.id,
                name: asset.name,
                size: asset.size,
                revision: asset.updated_at,
            });
        }
        releases.push(PublishedRelease {
            id: release.id,
            tag: release.tag_name,
            published_at,
            draft: release.draft,
            prerelease: release.prerelease,
            assets,
        });
    }
    Ok(Listing { releases, urls })
}

/// A verified image together with the retained source files the privileged
/// helper re-verifies: `[image, SHA256SUMS, SHA256SUMS.minisig]`.
pub struct Fetched {
    pub release: PublishedRelease,
    pub image: VerifiedImage,
    pub sources: [File; 3],
}

fn private_directory(base: &Path) -> std::io::Result<PathBuf> {
    let mut nonce = [0; 8];
    getrandom::fill(&mut nonce).map_err(|_| std::io::Error::other("entropy unavailable"))?;
    let path = base.join(format!("ais-host-{}", crate::release::hex(&nonce)));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&path)?;
    Ok(path)
}

fn download_asset(
    http: &dyn Http,
    listing: &Listing,
    asset: &AssetIdentity,
    directory: &Path,
) -> Result<File, FetchError> {
    let url = listing.urls.get(&asset.id).ok_or(FetchError::Address)?;
    if !approved_address(url) {
        return Err(FetchError::Address);
    }
    let path = directory.join(format!("asset-{}", asset.id));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&path)?;
    http.get(url, asset.size, &mut file)?;
    file.sync_all()?;
    if file.metadata()?.len() != asset.size {
        return Err(FetchError::Size);
    }
    file.rewind()?;
    Ok(file)
}

/// Try compatible releases newest first. Only an authenticated image with an
/// unsupported layout lets an older release be tried; every other failure
/// (bad signature, checksum, size, network) stops the operation.
pub fn fetch_verified(
    http: &dyn Http,
    verifier: &ImageVerifier,
    listing_url: &str,
    work_base: &Path,
) -> Result<Fetched, FetchError> {
    if !approved_address(listing_url) {
        return Err(FetchError::Address);
    }
    let mut body = Vec::new();
    http.get(listing_url, MAX_LISTING_BYTES, &mut body)?;
    let listing = parse_listing(&body)?;
    verify_listing(http, verifier, listing, work_base)
}

/// Recovery uses the exact tag endpoint, including releases older than the
/// discovery page. It never falls back to a different release.
pub fn fetch_verified_tag(
    http: &dyn Http,
    verifier: &ImageVerifier,
    tag: &str,
    digest: [u8; 32],
    work_base: &Path,
) -> Result<Fetched, FetchError> {
    if !crate::release::valid_live_tag(tag) {
        return Err(FetchError::JournalMismatch);
    }
    let url = format!("https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}");
    let mut body = Vec::new();
    http.get(&url, MAX_LISTING_BYTES, &mut body)?;
    let release: ApiRelease = serde_json::from_slice(&body).map_err(|_| FetchError::Listing)?;
    if release.tag_name != tag {
        return Err(FetchError::JournalMismatch);
    }
    let fetched = verify_listing(
        http,
        verifier,
        listing_from_releases(vec![release])?,
        work_base,
    )?;
    if fetched.image.digest() != digest {
        return Err(FetchError::JournalMismatch);
    }
    Ok(fetched)
}

fn verify_listing(
    http: &dyn Http,
    verifier: &ImageVerifier,
    listing: Listing,
    work_base: &Path,
) -> Result<Fetched, FetchError> {
    let directory = private_directory(work_base)?;
    let mut layout_rejected = false;
    for candidate in select_release_candidates(&listing.releases) {
        let selection = candidate?;
        let release = listing
            .releases
            .iter()
            .find(|release| release.tag == selection.tag())
            .ok_or(FetchError::NoRelease)?
            .clone();
        let image_file = download_asset(http, &listing, selection.image(), &directory)?;
        let mut sums_file = download_asset(http, &listing, selection.sums(), &directory)?;
        let mut signature_file = download_asset(http, &listing, selection.signature(), &directory)?;
        let mut sums = Vec::new();
        let mut signature = Vec::new();
        sums_file.read_to_end(&mut sums)?;
        signature_file.read_to_end(&mut signature)?;
        sums_file.rewind()?;
        signature_file.rewind()?;
        let retained = image_file.try_clone()?;
        let download = DownloadedImage {
            source: image_file,
            image_identity: selection.image().clone(),
            sums_identity: selection.sums().clone(),
            signature_identity: selection.signature().clone(),
            sums,
            signature,
        };
        match verifier.verify(&selection, download) {
            Ok(image) => {
                return Ok(Fetched {
                    release,
                    image,
                    sources: [retained, sums_file, signature_file],
                });
            }
            Err(TrustError::Layout) => layout_rejected = true,
            Err(error) => return Err(error.into()),
        }
    }
    Err(if layout_rejected {
        FetchError::Trust(TrustError::Layout)
    } else {
        FetchError::NoRelease
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_release_hosts_are_approved() {
        for ok in [
            "https://api.github.com/repos/o/r/releases",
            "https://github.com/o/r/releases/download/live-v1/x",
            "https://objects.githubusercontent.com/a",
        ] {
            assert!(approved_address(ok), "{ok}");
        }
        for bad in [
            "http://github.com/x",
            "https://github.com.evil.invalid/x",
            "https://notgithub.example/x",
            "https://user@github.com/x",
            "https://github.com:8443/x",
            "ftp://github.com/x",
            "https:///x",
        ] {
            assert!(!approved_address(bad), "{bad}");
        }
    }

    #[test]
    fn redirects_stay_https_and_resolve_relative_locations() {
        assert_eq!(
            redirect_target("https://github.com/a/b", "/c").as_deref(),
            Some("https://github.com/c")
        );
        assert_eq!(
            redirect_target(
                "https://github.com/a",
                "https://objects.githubusercontent.com/x"
            )
            .as_deref(),
            Some("https://objects.githubusercontent.com/x")
        );
        assert!(redirect_target("https://github.com/a", "http://github.com/x").is_none());
        assert!(redirect_target("https://github.com/a", "//other.example/x").is_none());
    }

    #[test]
    fn listing_maps_assets_and_timestamps() {
        let json = br#"[{"id":7,"tag_name":"live-v1.0.0","draft":false,"prerelease":false,
          "published_at":"2026-10-01T00:00:00Z",
          "assets":[{"id":71,"name":"SHA256SUMS","size":10,"updated_at":"2026-10-01T00:00:01Z",
          "browser_download_url":"https://github.com/o/r/releases/download/live-v1.0.0/SHA256SUMS"}]},
          {"id":8,"tag_name":"live-v2","published_at":null,"assets":[]}]"#;
        let listing = parse_listing(json).unwrap();
        assert_eq!(listing.releases.len(), 1);
        assert_eq!(listing.releases[0].published_at, 1_790_812_800);
        assert_eq!(
            listing.releases[0].assets[0].revision,
            "2026-10-01T00:00:01Z"
        );
        assert!(parse_listing(b"not json").is_err());
    }
}
