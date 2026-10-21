//! The host adapter for this computer: runs `ais host --stdio` and speaks the
//! framed protocol of src/host/protocol.ts. Diagnostics are fixed strings so
//! adapter output (which may contain configuration) never reaches IPC.
use crate::flow_adapter::{HostAdapter, HostTarget, ImportSummary};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
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
    decode_frames(bytes).map(|(_, payload)| payload)
}

fn decode_frames(bytes: &[u8]) -> Result<(serde_json::Value, Vec<u8>), String> {
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
    Ok((header, payload.to_vec()))
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

/// Where a flow target runs. SSH aliases name entries of the user's SSH
/// configuration and are validated like src/host/remote.ts::HOST_PATTERN.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostSource {
    Local,
    Ssh(String),
}

pub fn valid_ssh_alias(alias: &str) -> bool {
    let mut bytes = alias.bytes();
    alias.len() <= 253
        && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b'-'))
}

/// Argument vector only, never a shell string. Unknown host keys are refused
/// (no prompt, no auto-accept) so a first connection is made outside the app.
pub fn host_argv(source: &HostSource, ssh: &str, ais: &str) -> Result<Vec<String>, String> {
    match source {
        HostSource::Local => Ok(vec![ais.into(), "host".into(), "--stdio".into()]),
        HostSource::Ssh(alias) if valid_ssh_alias(alias) => Ok([
            ssh,
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=2",
            alias,
            "ais",
            "host",
            "--stdio",
        ]
        .map(String::from)
        .to_vec()),
        HostSource::Ssh(_) => Err("invalid SSH host alias".into()),
    }
}

pub fn encode_import_request(payload_bytes: usize) -> Vec<u8> {
    let body =
        format!(r#"{{"version":1,"operation":"importLogs","payloadBytes":{payload_bytes}}}"#);
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(body.as_bytes());
    frame
}

/// Parse the importLogs response result; the receiver is untrusted input.
pub fn decode_import_summary(bytes: &[u8]) -> Result<ImportSummary, String> {
    let (header, _) = decode_frames(bytes)?;
    serde_json::from_value(header["result"].clone())
        .map_err(|_| "the host adapter returned an invalid response".into())
}

/// Runs the same `ais host --stdio` protocol on this computer or over SSH.
/// The resolver maps native handles to sources; the renderer never names one.
type Resolver = Box<dyn FnMut(&HostTarget) -> Result<HostSource, String> + Send>;

pub struct ProcessHostAdapter {
    resolve: Resolver,
    ssh: String,
    ais: Option<String>,
    timeout: Duration,
}

impl ProcessHostAdapter {
    pub fn new(
        resolve: impl FnMut(&HostTarget) -> Result<HostSource, String> + Send + 'static,
    ) -> Self {
        Self {
            resolve: Box::new(resolve),
            ssh: "ssh".into(),
            ais: Some("ais".into()),
            timeout: Duration::from_secs(120),
        }
    }

    /// The program for this computer, or None when `ais` is not installed.
    /// Remote hosts are unaffected: they resolve `ais` in their own login shell.
    pub fn with_local_program(mut self, program: Option<String>) -> Self {
        self.ais = program;
        self
    }

    fn call(
        &mut self,
        target: &HostTarget,
        request: &[u8],
        payload: &[u8],
    ) -> Result<Vec<u8>, String> {
        let fail = || "the host adapter failed".to_string();
        let source = (self.resolve)(target)?;
        let ais = match (&source, &self.ais) {
            (HostSource::Local, None) => {
                return Err("ais is not installed for this user; install it and try again.".into());
            }
            (_, ais) => ais.as_deref().unwrap_or("ais"),
        };
        let argv = host_argv(&source, &self.ssh, ais)?;
        let mut child = Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "the host adapter could not be started".to_string())?;
        let mut stdin = child.stdin.take().ok_or_else(fail)?;
        let stdout = child.stdout.take().ok_or_else(fail)?;
        let (request, payload) = (request.to_vec(), payload.to_vec());
        // Both pipes are serviced concurrently so a large payload cannot deadlock.
        let writer = std::thread::spawn(move || {
            let result = stdin
                .write_all(&request)
                .and_then(|_| stdin.write_all(&payload));
            drop(stdin);
            result.is_ok()
        });
        let reader = std::thread::spawn(move || {
            let mut output = Vec::new();
            let read = stdout.take(MAX_RESPONSE_BYTES + 1).read_to_end(&mut output);
            (read.is_ok(), output)
        });
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let wrote = writer.join().map_err(|_| fail())?;
        let (read, output) = reader.join().map_err(|_| fail())?;
        if !status.is_some_and(|status| status.success())
            || !wrote
            || !read
            || output.len() as u64 > MAX_RESPONSE_BYTES
        {
            return Err(fail());
        }
        Ok(output)
    }
}

impl HostAdapter for ProcessHostAdapter {
    fn export_snapshot(&mut self, target: &HostTarget) -> Result<Vec<u8>, String> {
        let output = self.call(target, &encode_export_request(), &[])?;
        decode_response(&output)
    }

    fn import_logs(&mut self, target: &HostTarget, tar: &[u8]) -> Result<ImportSummary, String> {
        let output = self.call(target, &encode_import_request(tar.len()), tar)?;
        decode_import_summary(&output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_argv_is_strict_and_never_a_shell_string() {
        let argv = host_argv(&HostSource::Ssh("user@host.example".into()), "ssh", "ais").unwrap();
        assert!(
            argv.windows(2)
                .any(|w| w == ["-o", "StrictHostKeyChecking=yes"])
        );
        assert!(argv.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert_eq!(
            argv[argv.len() - 4..],
            ["user@host.example", "ais", "host", "--stdio"]
        );
        for bad in ["-oProxyCommand=x", "a b", "a;b", "", "a$(x)", "a/b"] {
            assert!(host_argv(&HostSource::Ssh(bad.into()), "ssh", "ais").is_err());
        }
        assert_eq!(
            host_argv(&HostSource::Local, "ssh", "ais").unwrap(),
            ["ais", "host", "--stdio"]
        );
    }

    #[test]
    fn a_missing_local_program_is_a_fixed_error_but_ssh_is_unaffected() {
        let mut adapter =
            ProcessHostAdapter::new(|_| Ok(HostSource::Local)).with_local_program(None);
        let target = HostTarget::new("local").unwrap();
        assert_eq!(
            adapter.export_snapshot(&target).unwrap_err(),
            "ais is not installed for this user; install it and try again."
        );
    }

    #[test]
    fn import_summaries_come_from_the_response_result() {
        let body = br#"{"version":1,"ok":true,"payloadBytes":0,"result":{"applied":2,"skipped":1,"conflicts":["a"]}}"#;
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body);
        let summary = decode_import_summary(&frame).unwrap();
        assert_eq!(
            (summary.applied, summary.skipped, summary.conflicts.len()),
            (2, 1, 1)
        );
        let bad = String::from_utf8_lossy(body).replace("\"skipped\":1,", "");
        let mut frame = (bad.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(bad.as_bytes());
        assert!(decode_import_summary(&frame).is_err());
        let request = encode_import_request(7);
        assert!(
            std::str::from_utf8(&request[4..])
                .unwrap()
                .contains(r#""payloadBytes":7"#)
        );
    }
}
