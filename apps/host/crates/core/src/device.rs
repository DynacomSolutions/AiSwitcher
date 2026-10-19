use crate::release::{VerifiedImage, sha256};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub id: String,
    pub display_identifier: String,
    pub model: Option<String>,
    pub capacity_bytes: u64,
    pub transport: String,
    pub system: bool,
    pub writable: bool,
    pub layout_status: String,
}

/// Observations must come from native ancestry inspection, never webview input.
/// A connection identity is required even where the hardware has no serial.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceObservation {
    pub os_identity: String,
    pub connection_identity: String,
    pub display_identifier: String,
    pub serial: Option<String>,
    pub capacity_bytes: u64,
    pub sector_bytes: u32,
    pub table_fingerprint: [u8; 32],
    pub ancestry_fingerprint: [u8; 32],
    pub mount_fingerprint: [u8; 32],
    pub external_usb: bool,
    pub internal: bool,
    pub system_backing: bool,
    pub ancestry_complete: bool,
    pub writable: bool,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DeviceError {
    #[error("The device is not an eligible external USB target.")]
    Ineligible,
    #[error("The device identity, capacity, partitions or mounts changed.")]
    Changed,
    #[error("The planned range is unaligned or outside the device.")]
    Bounds,
    #[error("Type the exact displayed device identifier.")]
    Confirmation,
    #[error("The confirmation expired, was invalidated or has already been used.")]
    Stale,
    #[error("Secure confirmation generation failed.")]
    Entropy,
    #[error("This operation needs a reviewed image layout contract.")]
    LayoutUnavailable,
}

impl DeviceObservation {
    pub fn validate(&self) -> Result<(), DeviceError> {
        if self.os_identity.is_empty()
            || self.connection_identity.is_empty()
            || self.display_identifier.trim().is_empty()
            || self.display_identifier.chars().any(char::is_control)
            || !self.external_usb
            || self.internal
            || self.system_backing
            || !self.ancestry_complete
            || !self.writable
        {
            return Err(DeviceError::Ineligible);
        }
        if !matches!(self.sector_bytes, 512 | 4096)
            || self.capacity_bytes == 0
            || self.capacity_bytes % u64::from(self.sector_bytes) != 0
        {
            return Err(DeviceError::Bounds);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteOperation {
    CreateLayout,
    ReplaceBase,
    ResetPersist,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: u64,
    pub length: u64,
}

impl ByteRange {
    pub fn validate(self, device: &DeviceObservation) -> Result<(), DeviceError> {
        let sector = u64::from(device.sector_bytes);
        if sector == 0
            || self.length == 0
            || self.start % sector != 0
            || self.length % sector != 0
            || self
                .start
                .checked_add(self.length)
                .is_none_or(|end| end > device.capacity_bytes)
        {
            return Err(DeviceError::Bounds);
        }
        Ok(())
    }
}

/// A serialisable review, but never a deserialisable authority to write.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePlan {
    operation: WriteOperation,
    device: DeviceObservation,
    source_digest: [u8; 32],
    compressed_digest: [u8; 32],
    release: crate::release::ReleaseSelection,
    ranges: Vec<ByteRange>,
}

impl WritePlan {
    /// Production creation additionally needs a reviewed GPT/exchange transformation.
    /// Do not turn this unavailable contract into a raw-image-only create flow.
    pub fn create_layout(
        _image: &VerifiedImage,
        _device: DeviceObservation,
    ) -> Result<Self, DeviceError> {
        Err(DeviceError::LayoutUnavailable)
    }

    /// Regular-file harness only. It does not claim to create a bootable layout.
    #[cfg(feature = "file-test")]
    pub fn synthetic_image(
        image: &VerifiedImage,
        device: DeviceObservation,
    ) -> Result<Self, DeviceError> {
        device.validate()?;
        let range = ByteRange {
            start: 0,
            length: image.len(),
        };
        range.validate(&device)?;
        Ok(Self {
            operation: WriteOperation::CreateLayout,
            device,
            source_digest: image.digest(),
            compressed_digest: image.compressed_digest(),
            release: image.selection().clone(),
            ranges: vec![range],
        })
    }

    pub fn device(&self) -> &DeviceObservation {
        &self.device
    }
    pub fn ranges(&self) -> &[ByteRange] {
        &self.ranges
    }
    pub fn operation(&self) -> WriteOperation {
        self.operation
    }
    pub fn digest(&self) -> [u8; 32] {
        // Only fixed struct fields, ordered vectors and integer values are encoded.
        sha256(&serde_json::to_vec(self).expect("write plans contain only JSON-safe values"))
    }
    pub fn revalidate(
        &self,
        current: &DeviceObservation,
        image: &VerifiedImage,
    ) -> Result<(), DeviceError> {
        current.validate()?;
        if current != &self.device {
            return Err(DeviceError::Changed);
        }
        if image.digest() != self.source_digest
            || image.compressed_digest() != self.compressed_digest
            || image.selection() != &self.release
            || self.ranges.len() != 1
            || self.ranges[0].length != image.len()
        {
            return Err(DeviceError::Changed);
        }
        for range in &self.ranges {
            range.validate(current)?;
        }
        Ok(())
    }
}

pub struct ConfirmationTicket {
    nonce: [u8; 32],
}
struct Approval {
    plan: [u8; 32],
    identifier: String,
    expires: Instant,
}

/// Keep one book per app session. Refreshes and changed choices call invalidate.
#[derive(Default)]
pub struct ConfirmationBook {
    approvals: BTreeMap<[u8; 32], Approval>,
}

impl ConfirmationBook {
    pub fn invalidate(&mut self) {
        self.approvals.clear();
    }

    pub fn issue(
        &mut self,
        plan: &WritePlan,
        typed: &str,
        now: Instant,
        ttl: Duration,
    ) -> Result<ConfirmationTicket, DeviceError> {
        // A new attempt invalidates previous approvals, including a wrong attempt.
        self.invalidate();
        if typed != plan.device.display_identifier || typed.is_empty() {
            return Err(DeviceError::Confirmation);
        }
        if ttl.is_zero() || ttl > Duration::from_secs(120) {
            return Err(DeviceError::Stale);
        }
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| DeviceError::Entropy)?;
        self.approvals.insert(
            nonce,
            Approval {
                plan: plan.digest(),
                identifier: typed.to_owned(),
                expires: now + ttl,
            },
        );
        Ok(ConfirmationTicket { nonce })
    }

    pub fn consume(
        &mut self,
        ticket: &ConfirmationTicket,
        plan: &WritePlan,
        current: &DeviceObservation,
        image: &VerifiedImage,
        now: Instant,
    ) -> Result<(), DeviceError> {
        // Remove before checking, so even a refused attempt cannot be replayed.
        let approval = self
            .approvals
            .remove(&ticket.nonce)
            .ok_or(DeviceError::Stale)?;
        if now >= approval.expires
            || approval.plan != plan.digest()
            || approval.identifier != current.display_identifier
        {
            return Err(DeviceError::Stale);
        }
        plan.revalidate(current, image)
    }
}

/// All platform writes remain unavailable until their native evidence is supplied.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSupport {
    pub enabled: bool,
    pub reason: &'static str,
}

pub fn write_support() -> WriteSupport {
    WriteSupport {
        enabled: false,
        reason: "Image layout verification and native helper authorisation are not available in this build.",
    }
}

/// Implementations own an already-open handle. No writer takes a target path.
pub trait WriteTarget: std::io::Read + std::io::Write + std::io::Seek {
    fn observe(&self) -> std::io::Result<DeviceObservation>;
    fn lock_exclusive(&mut self) -> std::io::Result<()>;
    fn flush_durable(&mut self) -> std::io::Result<()>;
}

#[derive(Debug, Eq, PartialEq)]
pub enum WriteFailure {
    Refused(&'static str),
    /// Confirmed bytes are a lower bound, not a claim that other bytes are intact.
    Incomplete {
        confirmed_bytes: u64,
        reason: &'static str,
    },
}

/// Callers own the OS-authorised channel and operation lock. This routine is the
/// shared bounded byte writer, not an elevation or device-discovery mechanism.
#[cfg(feature = "file-test")]
pub fn write_image(
    target: &mut impl WriteTarget,
    image: &mut VerifiedImage,
    plan: &WritePlan,
    approvals: &mut ConfirmationBook,
    ticket: &ConfirmationTicket,
    now: Instant,
    mut cancelled: impl FnMut() -> bool,
) -> Result<u64, WriteFailure> {
    use std::io::SeekFrom;
    let current = target
        .observe()
        .map_err(|_| WriteFailure::Refused("device observation"))?;
    approvals
        .consume(ticket, plan, &current, image, now)
        .map_err(|_| WriteFailure::Refused("confirmation"))?;
    if cancelled() {
        return Err(WriteFailure::Refused("cancelled"));
    }
    image
        .revalidate_source()
        .map_err(|_| WriteFailure::Refused("image source changed"))?;
    target
        .lock_exclusive()
        .map_err(|_| WriteFailure::Refused("exclusive access"))?;
    let current = target
        .observe()
        .map_err(|_| WriteFailure::Refused("device observation"))?;
    plan.revalidate(&current, image)
        .map_err(|_| WriteFailure::Refused("device changed"))?;
    if cancelled() {
        return Err(WriteFailure::Refused("cancelled"));
    }
    let range = plan.ranges[0];
    target
        .seek(SeekFrom::Start(range.start))
        .map_err(|_| WriteFailure::Refused("seek"))?;
    let mut written = 0_u64;
    let budget = Instant::now();
    let failure = |written, reason| {
        if written == 0 {
            WriteFailure::Refused(reason)
        } else {
            WriteFailure::Incomplete {
                confirmed_bytes: written,
                reason,
            }
        }
    };
    for chunk in image.bytes().chunks(64 * 1024) {
        if cancelled() || budget.elapsed() >= Duration::from_secs(600) {
            let _ = target.flush_durable();
            return Err(failure(written, "cancelled or timed out"));
        }
        let current = target
            .observe()
            .map_err(|_| failure(written, "device disconnected"))?;
        // Synthetic files have no partition table. Production phase fingerprints
        // must follow the reviewed image transformation before writes are enabled.
        plan.revalidate(&current, image)
            .map_err(|_| failure(written, "device changed"))?;
        let mut remaining = chunk;
        while !remaining.is_empty() {
            if cancelled() || budget.elapsed() >= Duration::from_secs(600) {
                let _ = target.flush_durable();
                return Err(failure(written, "cancelled or timed out"));
            }
            match target.write(remaining) {
                Ok(0) => return Err(failure(written, "zero-length write")),
                Ok(count) if count <= remaining.len() => {
                    written += count as u64;
                    remaining = &remaining[count..];
                }
                Ok(_) => {
                    return Err(WriteFailure::Incomplete {
                        confirmed_bytes: written,
                        reason: "invalid write result",
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    return Err(WriteFailure::Incomplete {
                        confirmed_bytes: written,
                        reason: "write failed",
                    });
                }
            }
        }
    }
    target
        .flush_durable()
        .map_err(|_| WriteFailure::Incomplete {
            confirmed_bytes: written,
            reason: "flush failed",
        })?;
    let current = target
        .observe()
        .map_err(|_| failure(written, "device disconnected"))?;
    plan.revalidate(&current, image)
        .map_err(|_| failure(written, "device changed"))?;
    image
        .revalidate_source()
        .map_err(|_| failure(written, "image source changed"))?;
    target
        .seek(SeekFrom::Start(range.start))
        .map_err(|_| failure(written, "readback seek"))?;
    let mut readback = [0; 64 * 1024];
    for expected in image.bytes().chunks(readback.len()) {
        if cancelled() || budget.elapsed() >= Duration::from_secs(600) {
            return Err(failure(written, "readback cancelled or timed out"));
        }
        target
            .read_exact(&mut readback[..expected.len()])
            .map_err(|_| failure(written, "readback failed"))?;
        if readback[..expected.len()] != *expected {
            return Err(failure(written, "readback mismatch"));
        }
    }
    Ok(written)
}
