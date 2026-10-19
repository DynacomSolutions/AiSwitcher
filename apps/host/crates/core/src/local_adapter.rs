//! The host adapter for this computer: runs `ais host --stdio` and speaks the
//! framed protocol of src/host/protocol.ts. Diagnostics are fixed strings so
//! adapter output (which may contain configuration) never reaches IPC.
use crate::flow_adapter::{HostAdapter, HostTarget, ImportSummary};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
};

const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024 + 70 * 1024;

pub struct LocalHostAdapter {
    program: String,
}

impl Default for LocalHostAdapter {
    fn default() -> Self {
        Self {
            program: "ais".into(),
        }
    }
}

impl LocalHostAdapter {
    pub fn with_program(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
        }
    }
}

pub fn encode_export_request() -> Vec<u8> {
    let body = br#"{"version":1,"operation":"exportSnapshot","payloadBytes":0}"#;
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(body);
    frame
}

/// Split a response into its payload after checking the JSON header.
pub fn decode_response(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let fail = || "the host adapter returned an invalid response".to_string();
    let length = bytes
        .get(..4)
        .map(|prefix| u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize)
        .filter(|length| *length <= 64 * 1024)
        .ok_or_else(fail)?;
    let header: serde_json::Value =
        serde_json::from_slice(bytes.get(4..4 + length).ok_or_else(fail)?).map_err(|_| fail())?;
    let payload = &bytes[4 + length..];
    if header["version"] != 1
        || header["ok"] != true
        || header["payloadBytes"].as_u64() != Some(payload.len() as u64)
    {
        return Err(fail());
    }
    Ok(payload.to_vec())
}

impl HostAdapter for LocalHostAdapter {
    fn export_snapshot(&mut self, _target: &HostTarget) -> Result<Vec<u8>, String> {
        let mut child = Command::new(&self.program)
            .args(["host", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "the host adapter could not be started".to_string())?;
        let mut stdin = child.stdin.take().ok_or("the host adapter has no input")?;
        let write = stdin.write_all(&encode_export_request());
        drop(stdin);
        let mut output = Vec::new();
        let read = child
            .stdout
            .take()
            .ok_or("the host adapter has no output")?
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut output);
        let status = child
            .wait()
            .map_err(|_| "the host adapter failed".to_string())?;
        if write.is_err()
            || read.is_err()
            || !status.success()
            || output.len() as u64 > MAX_RESPONSE_BYTES
        {
            return Err("the host adapter failed".into());
        }
        decode_response(&output)
    }

    fn import_logs(&mut self, _target: &HostTarget, _tar: &[u8]) -> Result<ImportSummary, String> {
        Err("importing logs is not part of drive creation".into())
    }
}
