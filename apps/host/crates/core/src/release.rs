//! Release trust is independent of download transport. No downloaded key can
//! authorise an image. Production writes require a bundled key and reviewed layout.
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    time::{Duration, Instant},
};
use thiserror::Error;

pub const MAX_COMPRESSED_BYTES: u64 = 2_040_109_465; // 1.9 GiB, rounded down.
pub const MAX_IMAGE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_SUMS_BYTES: usize = 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4096;

#[derive(Debug, Error)]
pub enum TrustError {
    #[error("The bundled image trust key and reviewed layout are unavailable.")]
    ContractUnavailable,
    #[error("The release or asset identity is invalid or changed.")]
    AssetIdentity,
    #[error("Image signature verification failed.")]
    Signature,
    #[error("The checksum file is invalid or ambiguous.")]
    Checksums,
    #[error("The image checksum changed or does not match.")]
    Checksum,
    #[error("The image exceeds its permitted size or time budget.")]
    Limit,
    #[error("The image layout has not been approved.")]
    Layout,
    #[error("The image source is not a regular file.")]
    Source,
    #[error("Image input failed.")]
    Io(#[from] std::io::Error),
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
/// Streaming digest for files too large to hold in memory.
pub fn sha256_reader(reader: &mut impl std::io::Read) -> std::io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&buffer[..count]);
    }
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetIdentity {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedRelease {
    pub id: u64,
    pub tag: String,
    pub published_at: u64,
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<AssetIdentity>,
}

/// An operation keeps this selection even if a newer release is published.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSelection {
    release_id: u64,
    published_at: u64,
    tag: String,
    image: AssetIdentity,
    sums: AssetIdentity,
    signature: AssetIdentity,
}

impl ReleaseSelection {
    pub fn order(&self) -> (u64, u64) {
        (self.published_at, self.release_id)
    }
    pub fn image(&self) -> &AssetIdentity {
        &self.image
    }
    pub fn sums(&self) -> &AssetIdentity {
        &self.sums
    }
    pub fn signature(&self) -> &AssetIdentity {
        &self.signature
    }
    pub fn tag(&self) -> &str {
        &self.tag
    }
}

pub fn select_release(releases: &[PublishedRelease]) -> Result<ReleaseSelection, TrustError> {
    select_release_candidates(releases)
        .into_iter()
        .next()
        .unwrap_or(Err(TrustError::AssetIdentity))
}

/// Stable candidates are ordered by publication time and then release id.
/// Tag versions are intentionally not used as an ordering signal.
pub fn select_release_candidates(
    releases: &[PublishedRelease],
) -> Vec<Result<ReleaseSelection, TrustError>> {
    let mut ordered: Vec<_> = releases
        .iter()
        .filter(|release| {
            !release.draft
                && !release.prerelease
                && release.id != 0
                && release.published_at != 0
                && valid_live_tag(&release.tag)
        })
        .collect();
    ordered.sort_by_key(|release| {
        (
            std::cmp::Reverse(release.published_at),
            std::cmp::Reverse(release.id),
        )
    });
    ordered.into_iter().map(select_release_assets).collect()
}

pub(crate) fn valid_live_tag(tag: &str) -> bool {
    tag.strip_prefix("live-v").is_some_and(|version| {
        !version.is_empty()
            && version.len() <= 70
            && version
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    })
}

fn select_release_assets(release: &PublishedRelease) -> Result<ReleaseSelection, TrustError> {
    let mut names = BTreeMap::new();
    let mut ids = std::collections::BTreeSet::new();
    for asset in &release.assets {
        if asset.id == 0
            || asset.size == 0
            || asset.revision.is_empty()
            || !ids.insert(asset.id)
            || names.insert(asset.name.as_str(), asset).is_some()
        {
            return Err(TrustError::AssetIdentity);
        }
    }
    let lookup = |name: &str, maximum: u64| -> Result<AssetIdentity, TrustError> {
        let asset = names.get(name).ok_or(TrustError::AssetIdentity)?;
        if asset.size > maximum {
            return Err(TrustError::Limit);
        }
        Ok((*asset).clone())
    };
    Ok(ReleaseSelection {
        release_id: release.id,
        published_at: release.published_at,
        tag: release.tag.clone(),
        image: lookup(
            &format!("ais-live-x86_64-{}.img.zst", release.tag),
            MAX_COMPRESSED_BYTES,
        )?,
        sums: lookup("SHA256SUMS", MAX_SUMS_BYTES as u64)?,
        signature: lookup("SHA256SUMS.minisig", MAX_SIGNATURE_BYTES as u64)?,
    })
}

pub fn parse_checksums(bytes: &[u8]) -> Result<BTreeMap<String, [u8; 32]>, TrustError> {
    if bytes.is_empty() || bytes.len() > MAX_SUMS_BYTES {
        return Err(TrustError::Checksums);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| TrustError::Checksums)?;
    let mut sums = BTreeMap::new();
    for line in text.lines() {
        let bytes = line.as_bytes();
        if bytes.len() < 67 || bytes[64] != b' ' || !b" *".contains(&bytes[65]) {
            return Err(TrustError::Checksums);
        }
        let name = &line[66..];
        if name.starts_with('.')
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(TrustError::Checksums);
        }
        let mut digest = [0; 32];
        for (index, pair) in bytes[..64].as_chunks::<2>().0.iter().enumerate() {
            let part = std::str::from_utf8(pair).map_err(|_| TrustError::Checksums)?;
            digest[index] = u8::from_str_radix(part, 16).map_err(|_| TrustError::Checksums)?;
        }
        if sums.insert(name.to_owned(), digest).is_some() {
            return Err(TrustError::Checksums);
        }
    }
    Ok(sums)
}

/// Fields and constructors are private outside the explicitly non-release harness.
/// A missing bundled trust anchor must not be replaced by one from a download.
pub struct ImageVerifier {
    key: PublicKey,
    layout: ReviewedLayout,
}

#[derive(Clone, Copy)]
enum ReviewedLayout {
    #[cfg_attr(not(feature = "file-test"), allow(dead_code))]
    // only synthetic fixtures pin exact bytes
    Exact {
        hash: [u8; 32],
        size: u64,
    },
    LiveX86_64GptV1,
}

/// The production minisign public key is `image/release/minisign.pub`. If that
/// file is absent the bundled key is empty, `ImageVerifier::bundled` fails
/// closed, and `build.rs` refuses a release profile unless this variable is set.
pub const PLACEHOLDER_KEY_OVERRIDE_ENV: &str = "AIS_ALLOW_PLACEHOLDER_RELEASE_KEY";

impl ImageVerifier {
    pub fn bundled() -> Result<Self, TrustError> {
        let key = include_str!(concat!(env!("OUT_DIR"), "/bundled-image-key.txt"));
        if key.trim().is_empty() {
            return Err(TrustError::ContractUnavailable);
        }
        Ok(Self {
            key: PublicKey::decode(key.trim()).map_err(|_| TrustError::ContractUnavailable)?,
            layout: ReviewedLayout::LiveX86_64GptV1,
        })
    }

    /// A synthetic byte-exact layout pin, separate from production GPT validation.
    #[cfg(feature = "file-test")]
    pub fn synthetic(public_key: &str, layout_bytes: &[u8]) -> Result<Self, TrustError> {
        if layout_bytes.is_empty()
            || layout_bytes.len() as u64 > MAX_IMAGE_BYTES
            || !layout_bytes.len().is_multiple_of(512)
        {
            return Err(TrustError::Layout);
        }
        Ok(Self {
            key: PublicKey::decode(public_key).map_err(|_| TrustError::Signature)?,
            layout: ReviewedLayout::Exact {
                hash: sha256(layout_bytes),
                size: layout_bytes.len() as u64,
            },
        })
    }

    /// Test-only structural verifier for synthetic GPT fixtures.
    #[cfg(feature = "file-test")]
    pub fn synthetic_live_layout(public_key: &str) -> Result<Self, TrustError> {
        Ok(Self {
            key: PublicKey::decode(public_key).map_err(|_| TrustError::Signature)?,
            layout: ReviewedLayout::LiveX86_64GptV1,
        })
    }

    /// Verify candidate releases in publication order. Only a structurally
    /// unsupported but otherwise authenticated image permits trying an older
    /// candidate. A signature, checksum or asset failure is always fatal.
    pub fn verify_candidates(
        &self,
        candidates: impl IntoIterator<Item = Result<(ReleaseSelection, DownloadedImage), TrustError>>,
    ) -> Result<VerifiedImage, TrustError> {
        let mut last_layout_error = false;
        for candidate in candidates {
            let (selection, download) = candidate?;
            match self.verify(&selection, download) {
                Ok(image) => return Ok(image),
                Err(TrustError::Layout) => last_layout_error = true,
                Err(error) => return Err(error),
            }
        }
        if last_layout_error {
            Err(TrustError::Layout)
        } else {
            Err(TrustError::AssetIdentity)
        }
    }

    pub fn verify(
        &self,
        selection: &ReleaseSelection,
        download: DownloadedImage,
    ) -> Result<VerifiedImage, TrustError> {
        let DownloadedImage {
            mut source,
            image_identity,
            sums_identity,
            signature_identity,
            sums,
            signature,
        } = download;
        if image_identity != selection.image
            || sums_identity != selection.sums
            || signature_identity != selection.signature
            || sums.len() as u64 != selection.sums.size
            || signature.len() as u64 != selection.signature.size
        {
            return Err(TrustError::AssetIdentity);
        }
        if sums.len() > MAX_SUMS_BYTES || signature.len() > MAX_SIGNATURE_BYTES {
            return Err(TrustError::Limit);
        }
        let signed =
            Signature::decode(std::str::from_utf8(&signature).map_err(|_| TrustError::Signature)?)
                .map_err(|_| TrustError::Signature)?;
        self.key
            .verify(&sums, &signed, false)
            .map_err(|_| TrustError::Signature)?;
        let digest = *parse_checksums(&sums)?
            .get(&selection.image.name)
            .ok_or(TrustError::Checksums)?;
        let compressed = read_source(&mut source, selection.image.size)?;
        if sha256(&compressed) != digest {
            return Err(TrustError::Checksum);
        }
        let mut decoder = zstd::stream::read::Decoder::new(compressed.as_slice())?;
        decoder.window_log_max(27)?;
        let maximum = match self.layout {
            ReviewedLayout::Exact { size, .. } => size,
            ReviewedLayout::LiveX86_64GptV1 => MAX_IMAGE_BYTES,
        };
        let bytes = read_bounded(&mut decoder, maximum, Duration::from_secs(120))?;
        let verified_digest = match self.layout {
            ReviewedLayout::Exact { hash, size }
                if bytes.len() as u64 == size && sha256(&bytes) == hash =>
            {
                hash
            }
            ReviewedLayout::LiveX86_64GptV1 => {
                crate::layout::LiveImageLayout::parse(&bytes)?;
                sha256(&bytes)
            }
            _ => return Err(TrustError::Layout),
        };
        Ok(VerifiedImage {
            source,
            source_digest: digest,
            source_size: selection.image.size,
            bytes,
            digest: verified_digest,
            selection: selection.clone(),
        })
    }
}

/// Download transports must retain the selected asset identities, enforce their
/// size and request deadlines, and supply the opened regular file here.
pub struct DownloadedImage {
    pub source: File,
    pub image_identity: AssetIdentity,
    pub sums_identity: AssetIdentity,
    pub signature_identity: AssetIdentity,
    pub sums: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Cannot be deserialised or built from a claimed checksum by an IPC client.
pub struct VerifiedImage {
    source: File,
    source_digest: [u8; 32],
    source_size: u64,
    bytes: Vec<u8>,
    digest: [u8; 32],
    selection: ReleaseSelection,
}

impl VerifiedImage {
    pub fn len(&self) -> u64 {
        self.bytes.len() as u64
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
    pub fn compressed_digest(&self) -> [u8; 32] {
        self.source_digest
    }
    pub fn selection(&self) -> &ReleaseSelection {
        &self.selection
    }
    pub fn revalidate_source(&mut self) -> Result<(), TrustError> {
        if sha256(&read_source(&mut self.source, self.source_size)?) != self.source_digest {
            return Err(TrustError::Checksum);
        }
        Ok(())
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

fn read_source(file: &mut File, size: u64) -> Result<Vec<u8>, TrustError> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(TrustError::Source);
    }
    if size == 0 || size > MAX_COMPRESSED_BYTES || metadata.len() != size {
        return Err(TrustError::Limit);
    }
    file.seek(SeekFrom::Start(0))?;
    let bytes = read_bounded(file, size, Duration::from_secs(120))?;
    if bytes.len() as u64 != size {
        return Err(TrustError::Limit);
    }
    Ok(bytes)
}

fn read_bounded(
    reader: &mut impl Read,
    maximum: u64,
    budget: Duration,
) -> Result<Vec<u8>, TrustError> {
    let start = Instant::now();
    let mut bytes = Vec::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        if start.elapsed() >= budget {
            return Err(TrustError::Limit);
        }
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len() as u64 + read as u64 > maximum {
            return Err(TrustError::Limit);
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}
