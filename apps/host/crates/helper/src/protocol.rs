//! A bounded request description. Decoding is not authentication or approval.
use serde::Deserialize;
use thiserror::Error;

pub const MAX_REQUEST_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub operation: Operation,
    pub plan_digest: String,
    pub channel_binding: String,
    pub ticket: String,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    CreateLayout,
    ReplaceBase,
    ResetPersist,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ProtocolError {
    #[error("Invalid request frame.")]
    Frame,
    #[error("Invalid request description.")]
    Request,
    #[error("An authenticated native request channel is required.")]
    Unauthenticated,
}

/// Exactly one complete length-prefixed frame, supplied by a deadline-bound OS
/// transport. Never allocate using an unchecked peer-supplied length.
pub fn decode_frame(frame: &[u8]) -> Result<Request, ProtocolError> {
    let header: [u8; 4] = frame
        .get(..4)
        .ok_or(ProtocolError::Frame)?
        .try_into()
        .map_err(|_| ProtocolError::Frame)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_REQUEST_BYTES || frame.len() != length + 4 {
        return Err(ProtocolError::Frame);
    }
    let request: Request =
        serde_json::from_slice(&frame[4..]).map_err(|_| ProtocolError::Request)?;
    let digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if request.version != 1
        || !digest(&request.plan_digest)
        || !digest(&request.channel_binding)
        || !digest(&request.ticket)
    {
        return Err(ProtocolError::Request);
    }
    Ok(request)
}

/// No public constructor. Only a future native adapter may establish this proof
/// from OS peer credentials, bundled-helper identity and one-operation binding.
pub struct AuthenticatedChannel {
    _private: (),
}

pub fn require_native_channel() -> Result<AuthenticatedChannel, ProtocolError> {
    Err(ProtocolError::Unauthenticated)
}
