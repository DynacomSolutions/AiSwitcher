//! A bounded request description. Decoding is not authentication or approval.
use ais_host_core::release::PublishedRelease;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;

mod windows;
#[cfg(windows)]
pub use windows::windows_transport;
pub use windows::windows_wire;

pub const MAX_REQUEST_BYTES: usize = 4096;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub operation: Operation,
    pub plan_digest: String,
    pub channel_binding: String,
    pub ticket: String,
    pub release: PublishedRelease,
    pub drive_identity: ais_host_core::drive_identity::DriveIdentity,
    #[serde(default)]
    pub installed_image: Option<ais_host_core::update::InstalledImage>,
    pub device_identity: String,
    pub typed_confirmation: String,
    /// CLOCK_BOOTTIME nanoseconds from the app's exact-typing confirmation.
    pub confirmation_deadline_boot_ns: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, Eq, PartialEq)]
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
    #[error("The helper request expired or was replayed.")]
    ExpiredOrReplayed,
    #[error("The peer is not the pinned installed application.")]
    UntrustedPeer,
    #[error("The required root-owned package trust record is unavailable.")]
    PackageTrustUnavailable,
    #[error("The native request transport failed.")]
    Transport,
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
        || request.drive_identity.validate().is_err()
        || (request.operation != Operation::CreateLayout) != request.installed_image.is_some()
        || request.installed_image.as_ref().is_some_and(|installed| {
            installed.validate().is_err() || installed.identity != request.drive_identity
        })
        || !digest(&request.plan_digest)
        || !digest(&request.channel_binding)
        || !digest(&request.ticket)
        || request.confirmation_deadline_boot_ns == 0
        || request.device_identity.is_empty()
        || request.device_identity.len() > 128
        || request.typed_confirmation.is_empty()
        || request.typed_confirmation.len() > 128
    {
        return Err(ProtocolError::Request);
    }
    Ok(request)
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn operation_binding(challenge: &[u8; 32], request: &Request) -> [u8; 32] {
    fn append_field(output: &mut Vec<u8>, value: &[u8]) {
        output.extend_from_slice(&(value.len() as u64).to_be_bytes());
        output.extend_from_slice(value);
    }
    let operation = match request.operation {
        Operation::CreateLayout => 1u32,
        Operation::ReplaceBase => 2u32,
        Operation::ResetPersist => 3u32,
    };
    let release = serde_json::to_vec(&request.release).unwrap_or_default();
    let mut binding = Vec::with_capacity(1024);
    append_field(&mut binding, b"AIS-HOST-HELPER-OPERATION-V1");
    append_field(&mut binding, challenge);
    append_field(&mut binding, &request.version.to_be_bytes());
    append_field(&mut binding, &operation.to_be_bytes());
    append_field(&mut binding, request.plan_digest.as_bytes());
    append_field(&mut binding, request.ticket.as_bytes());
    append_field(
        &mut binding,
        &request.confirmation_deadline_boot_ns.to_be_bytes(),
    );
    append_field(&mut binding, request.device_identity.as_bytes());
    append_field(&mut binding, request.typed_confirmation.as_bytes());
    append_field(&mut binding, &release);
    append_field(
        &mut binding,
        &serde_json::to_vec(&request.drive_identity).unwrap_or_default(),
    );
    append_field(
        &mut binding,
        &serde_json::to_vec(&request.installed_image).unwrap_or_default(),
    );
    ais_host_core::release::sha256(&binding)
}

/// No public constructor. Only an authenticated native transport may establish this proof
/// after checking peer credentials, the client pin and one request.
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", windows)),
    allow(dead_code)
)]
pub struct AuthenticatedChannel {
    pub(crate) peer_pid: u32,
    pub(crate) peer_uid: u32,
    pub(crate) request_binding: [u8; 32],
    pub(crate) _single_use: (),
    #[cfg(target_os = "linux")]
    pub(crate) executable: std::fs::File,
    /// Audit token of the authenticated peer; its pid version changes on exec.
    #[cfg(target_os = "macos")]
    pub(crate) peer_token: [u8; 32],
    #[cfg(target_os = "macos")]
    pub(crate) team: String,
    /// Retained handle of the authenticated peer, so its process id cannot be
    /// recycled, and the application image the peer was matched against.
    #[cfg(windows)]
    pub(crate) peer_process: windows_transport::ProcessHandle,
    #[cfg(windows)]
    pub(crate) peer_image: std::path::PathBuf,
}

impl AuthenticatedChannel {
    #[cfg(target_os = "linux")]
    pub(crate) fn revalidate_sender(&self) -> Result<(), ProtocolError> {
        linux_transport::verify_pid_executable(self.peer_pid, &self.executable)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn revalidate_sender(&self) -> Result<(), ProtocolError> {
        macos_transport::verify_peer_token(&self.peer_token, &self.team)
    }

    #[cfg(windows)]
    pub(crate) fn revalidate_sender(&self) -> Result<(), ProtocolError> {
        windows_transport::verify_peer(&self.peer_process, &self.peer_image)
    }
}

pub fn require_native_channel() -> Result<AuthenticatedChannel, ProtocolError> {
    Err(ProtocolError::Unauthenticated)
}

#[cfg(target_os = "linux")]
pub mod linux_transport {
    use super::*;
    use ais_host_core::release::{hex, sha256};
    use std::{
        fs::{self, File, OpenOptions},
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::FileTypeExt,
        os::unix::net::UnixStream,
        path::Path,
        process::{Command, Stdio},
    };

    const CLIENT_PIN: &str = "/usr/lib/ais-host/authorized-client.sha256";
    const HELPER_PATH: &str = "/usr/libexec/ais-host/ais-host-helper";
    const PKEXEC_PATH: &str = "/usr/bin/pkexec";
    const MAX_PEER_EXECUTABLE_BYTES: u64 = 128 * 1024 * 1024;
    const IO_TIMEOUT: Duration = Duration::from_secs(5);
    const SOURCE_DESCRIPTOR_COUNT: usize = 3;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct UCred {
        pid: i32,
        uid: u32,
        gid: u32,
    }

    unsafe extern "C" {
        fn getsockopt(
            socket: i32,
            level: i32,
            option: i32,
            value: *mut u8,
            length: *mut u32,
        ) -> i32;
        fn clock_gettime(clock_id: i32, value: *mut Timespec) -> i32;
        fn recvmsg(socket: i32, message: *mut MessageHeader, flags: i32) -> isize;
    }

    #[repr(C)]
    struct Timespec {
        seconds: i64,
        nanoseconds: i64,
    }

    #[repr(C)]
    struct Iovec {
        base: *mut u8,
        length: usize,
    }

    #[repr(C)]
    struct MessageHeader {
        name: *mut std::ffi::c_void,
        name_length: u32,
        iov: *mut Iovec,
        iov_length: usize,
        control: *mut std::ffi::c_void,
        control_length: usize,
        flags: i32,
    }

    #[repr(C)]
    struct ControlHeader {
        length: usize,
        level: i32,
        kind: i32,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct Peer {
        pid: u32,
        uid: u32,
        gid: u32,
    }

    fn peer_credentials(stream: &UnixStream) -> Result<Peer, ProtocolError> {
        let mut credentials = UCred::default();
        let mut length = std::mem::size_of::<UCred>() as u32;
        // Linux SOL_SOCKET=1 and SO_PEERCRED=17.
        // SAFETY: credentials and length are valid writable buffers for getsockopt.
        let result = unsafe {
            getsockopt(
                stream.as_raw_fd(),
                1,
                17,
                (&mut credentials as *mut UCred).cast(),
                &mut length,
            )
        };
        if result != 0 || length as usize != std::mem::size_of::<UCred>() || credentials.pid <= 0 {
            return Err(ProtocolError::UntrustedPeer);
        }
        Ok(Peer {
            pid: credentials.pid as u32,
            uid: credentials.uid,
            gid: credentials.gid,
        })
    }

    fn pinned_client_digest() -> Result<[u8; 32], ProtocolError> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        verify_root_owned_path_ancestors(Path::new(CLIENT_PIN))?;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(0x20_000); // O_NOFOLLOW.
        let file = options
            .open(CLIENT_PIN)
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        let metadata = file
            .metadata()
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(ProtocolError::PackageTrustUnavailable);
        }
        let mut pin = String::new();
        file.take(256)
            .read_to_string(&mut pin)
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        let value = pin.trim();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ProtocolError::PackageTrustUnavailable);
        }
        let mut digest = [0; 32];
        for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            digest[index] = u8::from_str_radix(
                std::str::from_utf8(pair).map_err(|_| ProtocolError::PackageTrustUnavailable)?,
                16,
            )
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        }
        Ok(digest)
    }

    fn verify_root_owned_path_ancestors(path: &Path) -> Result<(), ProtocolError> {
        use std::os::unix::fs::MetadataExt;
        let mut current = path
            .parent()
            .ok_or(ProtocolError::PackageTrustUnavailable)?;
        loop {
            let metadata = fs::symlink_metadata(current)
                .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
            if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                return Err(ProtocolError::PackageTrustUnavailable);
            }
            if current == Path::new("/") {
                return Ok(());
            }
            current = current
                .parent()
                .ok_or(ProtocolError::PackageTrustUnavailable)?;
        }
    }

    fn verify_peer_executable(peer: Peer) -> Result<File, ProtocolError> {
        use std::os::unix::fs::MetadataExt;
        let expected = pinned_client_digest()?;
        let path = format!("/proc/{}/exe", peer.pid);
        let mut options = OpenOptions::new();
        options.read(true);
        // /proc/<pid>/exe intentionally resolves to the kernel-retained
        // executable inode. Opening it follows the procfs link and retains it.
        let mut executable = options
            .open(path)
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        let metadata = executable
            .metadata()
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        if !metadata.is_file()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
            || metadata.len() == 0
            || metadata.len() > MAX_PEER_EXECUTABLE_BYTES
        {
            return Err(ProtocolError::UntrustedPeer);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        Read::take(&mut executable, MAX_PEER_EXECUTABLE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        if bytes.len() as u64 != metadata.len() || sha256(&bytes) != expected {
            return Err(ProtocolError::UntrustedPeer);
        }
        Ok(executable)
    }

    fn verify_peer_still_running_same_executable(
        peer: Peer,
        retained: &File,
    ) -> Result<(), ProtocolError> {
        verify_pid_executable(peer.pid, retained)
    }

    pub(crate) fn verify_pid_executable(pid: u32, retained: &File) -> Result<(), ProtocolError> {
        use std::os::unix::fs::MetadataExt;
        let current =
            File::open(format!("/proc/{pid}/exe")).map_err(|_| ProtocolError::UntrustedPeer)?;
        let retained_metadata = retained
            .metadata()
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        let current_metadata = current
            .metadata()
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        if retained_metadata.dev() != current_metadata.dev()
            || retained_metadata.ino() != current_metadata.ino()
        {
            return Err(ProtocolError::UntrustedPeer);
        }
        Ok(())
    }

    pub fn boottime_ns() -> Result<u64, ProtocolError> {
        let mut value = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // Linux CLOCK_BOOTTIME=7 includes suspend time, so confirmation expires while suspended.
        // SAFETY: value is a valid writable timespec buffer.
        if unsafe { clock_gettime(7, &mut value) } != 0
            || value.seconds < 0
            || value.nanoseconds < 0
        {
            return Err(ProtocolError::Transport);
        }
        (value.seconds as u64)
            .checked_mul(1_000_000_000)
            .and_then(|seconds| seconds.checked_add(value.nanoseconds as u64))
            .ok_or(ProtocolError::Transport)
    }

    fn current_boottime_ns() -> Result<u64, ProtocolError> {
        boottime_ns()
    }

    /// The application sends a one-byte marker with exactly three source files
    /// attached. This keeps source authority in retained descriptors rather
    /// than renderer-controlled paths.
    fn enable_sender_credentials(stream: &UnixStream) -> Result<(), ProtocolError> {
        let enabled: libc::c_int = 1;
        // SAFETY: enabled is a live integer of the advertised length.
        if unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PASSCRED,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            )
        } != 0
        {
            return Err(ProtocolError::Transport);
        }
        Ok(())
    }

    fn receive_message(
        stream: &UnixStream,
        buffer: &mut [u8],
        peer: Peer,
        expected_files: usize,
    ) -> Result<(usize, Vec<File>), ProtocolError> {
        let mut iov = Iovec {
            base: buffer.as_mut_ptr(),
            length: buffer.len(),
        };
        let header_length = std::mem::size_of::<ControlHeader>();
        let descriptor_length = expected_files * std::mem::size_of::<i32>();
        let alignment = std::mem::size_of::<usize>();
        let control_length = 4096;
        let mut control = vec![0usize; control_length / alignment];
        let mut message = MessageHeader {
            name: std::ptr::null_mut(),
            name_length: 0,
            iov: &mut iov,
            iov_length: 1,
            control: control.as_mut_ptr().cast(),
            control_length,
            flags: 0,
        };
        // MSG_CMSG_CLOEXEC prevents descriptor inheritance by any later child.
        // SAFETY: message and all referenced storage remain writable and live.
        let count = unsafe { recvmsg(stream.as_raw_fd(), &mut message, 0x4000_0000) };
        if count < 0 {
            return Err(ProtocolError::Transport);
        }
        let allocated_length = control.len() * alignment;
        let returned_length = message.control_length;
        let parse_length = returned_length.min(allocated_length);
        let mut files = Vec::new();
        let mut offset = 0usize;
        let mut credentials = None;
        let mut rights_records = 0usize;
        let mut rights_shape_valid = true;
        while offset < parse_length {
            let available = parse_length - offset;
            if available < header_length {
                rights_shape_valid = false;
                break;
            }
            // SAFETY: available proves a complete aligned control header fits.
            let header = unsafe {
                std::ptr::read_unaligned(
                    control
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<ControlHeader>(),
                )
            };
            if header.length < header_length {
                rights_shape_valid = false;
                break;
            } else if header.level == libc::SOL_SOCKET
                && header.kind == libc::SCM_CREDENTIALS
                && header.length == header_length + std::mem::size_of::<UCred>()
                && header.length <= available
                && credentials.is_none()
            {
                // SAFETY: the checked record contains one complete ucred.
                let credential = unsafe {
                    std::ptr::read_unaligned(
                        control
                            .as_ptr()
                            .cast::<u8>()
                            .add(offset + header_length)
                            .cast::<UCred>(),
                    )
                };
                credentials = Some(Peer {
                    pid: credential.pid as u32,
                    uid: credential.uid,
                    gid: credential.gid,
                });
            } else if header.level != libc::SOL_SOCKET || header.kind != libc::SCM_RIGHTS {
                rights_shape_valid = false;
            }
            let bounded_length = header.length.min(available);
            let payload_length = bounded_length - header_length;
            if header.level == 1 && header.kind == 1 {
                rights_records += 1;
                if header.length > available
                    || !payload_length.is_multiple_of(std::mem::size_of::<i32>())
                    || header.length != header_length + descriptor_length
                {
                    rights_shape_valid = false;
                }
                // Interpret payload bytes as descriptors only after confirming
                // this is a SOL_SOCKET/SCM_RIGHTS record. Retain every complete
                // delivered descriptor immediately so all refusal paths close it.
                let descriptor_count = payload_length / std::mem::size_of::<i32>();
                for index in 0..descriptor_count {
                    let descriptor_offset =
                        offset + header_length + index * std::mem::size_of::<i32>();
                    // SAFETY: bounded payload length proves this complete int fits.
                    let descriptor = unsafe {
                        std::ptr::read_unaligned(
                            control
                                .as_ptr()
                                .cast::<u8>()
                                .add(descriptor_offset)
                                .cast::<i32>(),
                        )
                    };
                    if descriptor < 0 {
                        rights_shape_valid = false;
                    } else {
                        // SAFETY: SCM_RIGHTS created an owned descriptor in this process.
                        files.push(unsafe { File::from_raw_fd(descriptor) });
                    }
                }
            }
            if header.length > available {
                rights_shape_valid = false;
                break;
            }
            let aligned_length = header
                .length
                .checked_add(alignment - 1)
                .map(|length| length & !(alignment - 1));
            let Some(aligned_length) = aligned_length else {
                rights_shape_valid = false;
                break;
            };
            if aligned_length == 0 {
                rights_shape_valid = false;
                break;
            }
            if aligned_length > available {
                if header.length != available {
                    rights_shape_valid = false;
                }
                break;
            }
            offset += aligned_length;
        }
        // Linux may attach anonymous credentials to EOF after SHUT_WR.
        // There are no sender bytes to authenticate in that case. Ancillary
        // shape checks still reject truncation or unexpected descriptors.
        if count != 0 && credentials != Some(peer) {
            return Err(ProtocolError::UntrustedPeer);
        }
        if message.flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0
            || returned_length > allocated_length
            || rights_records != usize::from(expected_files != 0)
            || !rights_shape_valid
            || files.len() != expected_files
        {
            drop(files);
            return Err(ProtocolError::Request);
        }
        Ok((count as usize, files))
    }

    fn receive_source_descriptors(
        stream: &UnixStream,
        peer: Peer,
    ) -> Result<[File; 3], ProtocolError> {
        let mut marker = [0u8; 1];
        let (count, files) = receive_message(stream, &mut marker, peer, SOURCE_DESCRIPTOR_COUNT)?;
        if count != 1 || marker != [1] {
            return Err(ProtocolError::Request);
        }
        files.try_into().map_err(|_| ProtocolError::Request)
    }

    fn read_exact_before(
        stream: &mut UnixStream,
        mut buffer: &mut [u8],
        deadline: Instant,
        peer: Peer,
    ) -> Result<(), ProtocolError> {
        while !buffer.is_empty() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|duration| !duration.is_zero())
                .ok_or(ProtocolError::Transport)?;
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|_| ProtocolError::Transport)?;
            let (count, _) = receive_message(stream, buffer, peer, 0)?;
            if count == 0 {
                return Err(ProtocolError::Transport);
            }
            buffer = &mut buffer[count..];
        }
        Ok(())
    }

    fn read_one_request(
        stream: &mut UnixStream,
        deadline: Instant,
        peer: Peer,
    ) -> Result<Vec<u8>, ProtocolError> {
        let mut header = [0; 4];
        read_exact_before(stream, &mut header, deadline, peer)?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > MAX_REQUEST_BYTES {
            return Err(ProtocolError::Frame);
        }
        let mut frame = Vec::with_capacity(4 + length);
        frame.extend_from_slice(&header);
        frame.resize(4 + length, 0);
        read_exact_before(stream, &mut frame[4..], deadline, peer)?;
        let mut trailing = [0; 1];
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or(ProtocolError::Transport)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| ProtocolError::Transport)?;
        match receive_message(stream, &mut trailing, peer, 0) {
            Ok((0, _)) => Ok(frame),
            Err(error) => Err(error),
            _ => Err(ProtocolError::Frame),
        }
    }

    /// Authenticate one connection. Package-pin absence is a hard refusal, not
    /// a fallback to UID equality or the pkexec environment.
    pub fn authenticate_one(
        mut stream: UnixStream,
        invoking_uid: u32,
    ) -> Result<(AuthenticatedChannel, Request, [File; 3]), ProtocolError> {
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)))
            .map_err(|_| ProtocolError::Transport)?;
        let peer = peer_credentials(&stream)?;
        if peer.uid != invoking_uid {
            return Err(ProtocolError::UntrustedPeer);
        }
        let pinned_executable = verify_peer_executable(peer)?;
        enable_sender_credentials(&stream)?;
        let request_deadline = Instant::now() + IO_TIMEOUT;
        let mut challenge = [0; 32];
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut challenge))
            .map_err(|_| ProtocolError::Transport)?;
        stream
            .write_all(&challenge)
            .map_err(|_| ProtocolError::Transport)?;
        let sources = receive_source_descriptors(&stream, peer)?;
        let frame = read_one_request(&mut stream, request_deadline, peer)?;
        if peer_credentials(&stream)? != peer {
            return Err(ProtocolError::UntrustedPeer);
        }
        verify_peer_still_running_same_executable(peer, &pinned_executable)?;
        let request = decode_frame(&frame)?;
        let now = current_boottime_ns()?;
        if request.confirmation_deadline_boot_ns <= now
            || request.confirmation_deadline_boot_ns - now > 120_000_000_000
        {
            return Err(ProtocolError::ExpiredOrReplayed);
        }
        let expected = operation_binding(&challenge, &request);
        if hex(&expected) != request.channel_binding {
            return Err(ProtocolError::ExpiredOrReplayed);
        }
        Ok((
            AuthenticatedChannel {
                peer_pid: peer.pid,
                peer_uid: peer.uid,
                request_binding: expected,
                _single_use: (),
                executable: pinned_executable,
            },
            request,
            sources,
        ))
    }

    pub fn binding_for_client(challenge: &[u8; 32], request: &Request) -> String {
        hex(&operation_binding(challenge, request))
    }

    pub fn validate_runtime_directory(path: &Path, invoking_uid: u32) -> Result<(), ProtocolError> {
        use std::os::unix::fs::MetadataExt;
        let expected = Path::new("/run/user")
            .join(invoking_uid.to_string())
            .join("ais-host-helper");
        if path != expected {
            return Err(ProtocolError::UntrustedPeer);
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| ProtocolError::UntrustedPeer)?;
        if !metadata.is_dir() || metadata.uid() != invoking_uid || metadata.mode() & 0o077 != 0 {
            return Err(ProtocolError::UntrustedPeer);
        }
        Ok(())
    }

    /// The installed package must be root-owned: client pin, polkit policy,
    /// pkexec and the fixed helper path. Absence is a hard refusal.
    pub fn verify_installation() -> Result<(), ProtocolError> {
        use std::os::unix::fs::MetadataExt;
        pinned_client_digest()?;
        let policy_path = "/usr/share/polkit-1/actions/org.ais.host-helper.policy";
        let policy_metadata =
            fs::metadata(policy_path).map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        if !policy_metadata.is_file()
            || policy_metadata.uid() != 0
            || policy_metadata.mode() & 0o022 != 0
        {
            return Err(ProtocolError::PackageTrustUnavailable);
        }
        let policy =
            fs::read_to_string(policy_path).map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        if !policy.contains("org.ais.host-helper")
            || !policy.contains("/usr/libexec/ais-host/ais-host-helper")
        {
            return Err(ProtocolError::PackageTrustUnavailable);
        }
        for path in [PKEXEC_PATH, HELPER_PATH] {
            let metadata =
                fs::metadata(path).map_err(|_| ProtocolError::PackageTrustUnavailable)?;
            if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                return Err(ProtocolError::PackageTrustUnavailable);
            }
        }
        Ok(())
    }

    pub fn current_uid() -> u32 {
        unsafe extern "C" {
            fn getuid() -> u32;
        }
        // SAFETY: getuid has no arguments and cannot fail.
        unsafe { getuid() }
    }

    /// True only when the whole root-owned installation verifies.
    pub fn helper_installed() -> bool {
        verify_installation().is_ok()
    }

    /// Ask the installed helper (through pkexec) for a read-only observation of
    /// one disk, including its partition-table fingerprint. Output is bounded
    /// and strictly parsed; the caller still revalidates the observation.
    pub fn preview_observation(
        identity: &str,
    ) -> Result<ais_host_core::device::DeviceObservation, ProtocolError> {
        verify_installation()?;
        let mut child = Command::new(PKEXEC_PATH)
            .arg("--disable-internal-agent")
            .arg(HELPER_PATH)
            .arg("--preview")
            .arg(identity)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        let mut output = Vec::new();
        let read = child
            .stdout
            .take()
            .ok_or(ProtocolError::Transport)?
            .take(16 * 1024 + 1)
            .read_to_end(&mut output);
        let status = child.wait().map_err(|_| ProtocolError::Transport)?;
        if read.is_err() || !status.success() || output.len() > 16 * 1024 {
            return Err(ProtocolError::Transport);
        }
        let observation: ais_host_core::device::DeviceObservation =
            serde_json::from_slice(&output).map_err(|_| ProtocolError::Request)?;
        observation.validate().map_err(|_| ProtocolError::Request)?;
        Ok(observation)
    }

    pub fn preview_update(
        identity: &str,
    ) -> Result<ais_host_core::update::DriveSnapshot, ProtocolError> {
        verify_installation()?;
        let mut child = Command::new(PKEXEC_PATH)
            .arg("--disable-internal-agent")
            .arg(HELPER_PATH)
            .arg("--preview-update")
            .arg(identity)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        let mut output = Vec::new();
        let read = child
            .stdout
            .take()
            .ok_or(ProtocolError::Transport)?
            .take(160 * 1024 + 1)
            .read_to_end(&mut output);
        let status = child.wait().map_err(|_| ProtocolError::Transport)?;
        if read.is_err() || !status.success() || output.len() > 160 * 1024 {
            return Err(ProtocolError::Transport);
        }
        serde_json::from_slice(&output).map_err(|_| ProtocolError::Request)
    }

    /// Attach exactly three retained source files to a one-byte marker.
    pub fn send_source_descriptors(
        stream: &UnixStream,
        files: [&File; 3],
    ) -> Result<(), ProtocolError> {
        unsafe extern "C" {
            fn sendmsg(socket: i32, message: *const MessageHeader, flags: i32) -> isize;
        }
        let mut marker = [1u8];
        let mut iov = Iovec {
            base: marker.as_mut_ptr(),
            length: 1,
        };
        let header_length = std::mem::size_of::<ControlHeader>();
        let descriptor_length = SOURCE_DESCRIPTOR_COUNT * std::mem::size_of::<i32>();
        let alignment = std::mem::size_of::<usize>();
        let control_length = (header_length + descriptor_length + alignment - 1) & !(alignment - 1);
        let mut control = vec![0usize; control_length / alignment];
        let header = ControlHeader {
            length: header_length + descriptor_length,
            level: 1, // SOL_SOCKET
            kind: 1,  // SCM_RIGHTS
        };
        // SAFETY: the control buffer is aligned and large enough for one header
        // and three descriptors; fields are written within its bounds.
        unsafe {
            let base = control.as_mut_ptr().cast::<u8>();
            std::ptr::write_unaligned(base.cast::<ControlHeader>(), header);
            for (index, file) in files.iter().enumerate() {
                std::ptr::write_unaligned(
                    base.add(header_length + index * std::mem::size_of::<i32>())
                        .cast::<i32>(),
                    file.as_raw_fd(),
                );
            }
        }
        let message = MessageHeader {
            name: std::ptr::null_mut(),
            name_length: 0,
            iov: &mut iov,
            iov_length: 1,
            control: control.as_mut_ptr().cast(),
            control_length,
            flags: 0,
        };
        // SAFETY: message and referenced storage are live for the call.
        let sent = unsafe { sendmsg(stream.as_raw_fd(), &message, 0) };
        if sent == 1 {
            Ok(())
        } else {
            Err(ProtocolError::Transport)
        }
    }

    /// Serve one helper connection: send the retained sources, read the
    /// session challenge, bind and send the request, then half-close.
    pub fn serve_request(
        stream: &mut UnixStream,
        files: [&File; 3],
        mut request: Request,
    ) -> Result<(), ProtocolError> {
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)))
            .map_err(|_| ProtocolError::Transport)?;
        let mut challenge = [0u8; 32];
        stream
            .read_exact(&mut challenge)
            .map_err(|_| ProtocolError::Transport)?;
        send_source_descriptors(stream, files)?;
        request.channel_binding = binding_for_client(&challenge, &request);
        let body = serde_json::to_vec(&request).map_err(|_| ProtocolError::Request)?;
        if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
            return Err(ProtocolError::Frame);
        }
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&body);
        stream
            .write_all(&frame)
            .and_then(|_| stream.shutdown(std::net::Shutdown::Write))
            .map_err(|_| ProtocolError::Transport)
    }

    /// Full privileged session: private socket, pkexec launch, one request.
    pub fn run_session(
        invoking_uid: u32,
        files: [&File; 3],
        request: Request,
    ) -> Result<(), ProtocolError> {
        use std::os::unix::{fs::DirBuilderExt, net::UnixListener};
        let directory = Path::new("/run/user")
            .join(invoking_uid.to_string())
            .join("ais-host-helper");
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ProtocolError::UntrustedPeer),
        }
        validate_runtime_directory(&directory, invoking_uid)?;
        let mut name = [0u8; 8];
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut name))
            .map_err(|_| ProtocolError::Transport)?;
        let socket = directory.join(format!("{}.sock", hex(&name)));
        let listener = UnixListener::bind(&socket).map_err(|_| ProtocolError::Transport)?;
        let _cleanup = RemoveOnDrop(socket.clone());
        fs::set_permissions(&socket, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .map_err(|_| ProtocolError::Transport)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| ProtocolError::Transport)?;
        let mut child = launch_pkexec(&socket, invoking_uid)?;
        // The user may be typing a password, so wait generously for the connect.
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if child
                        .try_wait()
                        .map_err(|_| ProtocolError::Transport)?
                        .is_some()
                        || Instant::now() >= deadline
                    {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(ProtocolError::Transport);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProtocolError::Transport);
                }
            }
        };
        stream
            .set_nonblocking(false)
            .map_err(|_| ProtocolError::Transport)?;
        let served = serve_request(&mut stream, files, request);
        let status = child.wait().map_err(|_| ProtocolError::Transport)?;
        served?;
        if status.success() {
            Ok(())
        } else {
            Err(ProtocolError::Transport)
        }
    }

    struct RemoveOnDrop(std::path::PathBuf);

    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    /// Start only the fixed installed helper through pkexec. The caller owns
    /// the private runtime socket and must bind its request to the challenge.
    /// Missing root-owned package trust intentionally prevents invocation.
    pub fn launch_pkexec(
        channel_path: &Path,
        invoking_uid: u32,
    ) -> Result<std::process::Child, ProtocolError> {
        let directory = channel_path.parent().ok_or(ProtocolError::UntrustedPeer)?;
        validate_runtime_directory(directory, invoking_uid)?;
        let metadata =
            fs::symlink_metadata(channel_path).map_err(|_| ProtocolError::UntrustedPeer)?;
        use std::os::unix::fs::MetadataExt;
        if !metadata.file_type().is_socket()
            || metadata.uid() != invoking_uid
            || metadata.mode() & 0o077 != 0
        {
            return Err(ProtocolError::UntrustedPeer);
        }
        verify_installation()?;
        Command::new(PKEXEC_PATH)
            .arg("--disable-internal-agent")
            .arg(HELPER_PATH)
            .arg("--serve")
            .arg(channel_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ProtocolError::PackageTrustUnavailable)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn sample_request() -> Request {
            static IDENTITY: std::sync::OnceLock<ais_host_core::drive_identity::DriveIdentity> =
                std::sync::OnceLock::new();
            serde_json::from_value(serde_json::json!({
                "version": 1,
                "operation": "createLayout",
                "planDigest": "a".repeat(64),
                "channelBinding": "b".repeat(64),
                "ticket": "c".repeat(64),
                "driveIdentity": IDENTITY.get_or_init(|| ais_host_core::drive_identity::DriveIdentity::fresh().unwrap()),
                "release": {
                    "id": 1,
                    "tag": "synthetic-v1",
                    "publishedAt": 1,
                    "draft": false,
                    "prerelease": false,
                    "assets": [
                        { "id": 1, "name": "SYNTHETIC_FIXTURE_IMAGE", "size": 1, "revision": "SYNTHETIC_FIXTURE_R1" },
                        { "id": 2, "name": "SYNTHETIC_FIXTURE_SUMS", "size": 1, "revision": "SYNTHETIC_FIXTURE_R2" },
                        { "id": 3, "name": "SYNTHETIC_FIXTURE_SIGNATURE", "size": 1, "revision": "SYNTHETIC_FIXTURE_R3" }
                    ]
                },
                "deviceIdentity": "synthetic-device",
                "typedConfirmation": "SYNTHETIC_FIXTURE_DEVICE",
                "confirmationDeadlineBootNs": 120
            }))
            .unwrap()
        }

        #[test]
        fn request_binding_length_prefixes_fields_and_binds_session_challenge() {
            let challenge = [9u8; 32];
            let mut first = sample_request();
            first.device_identity = "ab".into();
            first.typed_confirmation = "c".into();
            let mut second = sample_request();
            second.device_identity = "a".into();
            second.typed_confirmation = "bc".into();
            assert_ne!(
                operation_binding(&challenge, &first),
                operation_binding(&challenge, &second)
            );
            assert_ne!(
                operation_binding(&challenge, &first),
                operation_binding(&[8u8; 32], &first)
            );
        }

        #[test]
        fn source_descriptors_round_trip_through_the_server_envelope() {
            use std::os::unix::net::UnixStream;
            let (sender, receiver) = UnixStream::pair().unwrap();
            enable_sender_credentials(&receiver).unwrap();
            let peer = peer_credentials(&receiver).unwrap();
            let dir = std::env::temp_dir();
            let make = |name: &str, bytes: &[u8]| {
                let path = dir.join(format!("ais-fd-{}-{name}", std::process::id()));
                fs::write(&path, bytes).unwrap();
                let file = File::open(&path).unwrap();
                fs::remove_file(&path).unwrap();
                file
            };
            let files = [make("a", b"one"), make("b", b"22"), make("c", b"333")];
            send_source_descriptors(&sender, [&files[0], &files[1], &files[2]]).unwrap();
            let received = receive_source_descriptors(&receiver, peer).unwrap();
            let sizes: Vec<u64> = received
                .iter()
                .map(|f| f.metadata().unwrap().len())
                .collect();
            assert_eq!(sizes, [3, 2, 3]);
        }

        #[test]
        fn served_request_is_bound_to_the_challenge_and_decodes() {
            use std::os::unix::net::UnixStream;
            let (mut server, mut peer) = UnixStream::pair().unwrap();
            let dir = std::env::temp_dir();
            let path = dir.join(format!("ais-fd-{}-req", std::process::id()));
            fs::write(&path, b"x").unwrap();
            let file = File::open(&path).unwrap();
            fs::remove_file(&path).unwrap();
            let challenge = [7u8; 32];
            let helper = std::thread::spawn(move || {
                enable_sender_credentials(&peer).unwrap();
                let sender = peer_credentials(&peer).unwrap();
                peer.write_all(&challenge).unwrap();
                let files = receive_source_descriptors(&peer, sender).unwrap();
                let frame =
                    read_one_request(&mut peer, Instant::now() + Duration::from_secs(2), sender)
                        .unwrap();
                (files.len(), decode_frame(&frame).unwrap())
            });
            serve_request(&mut server, [&file, &file, &file], sample_request()).unwrap();
            let (count, request) = helper.join().unwrap();
            assert_eq!(count, 3);
            let mut expected = sample_request();
            expected.channel_binding = String::new();
            assert_eq!(
                request.channel_binding,
                binding_for_client(&challenge, &expected)
            );
        }

        #[test]
        fn malformed_or_truncated_descriptor_envelopes_are_refused() {
            use std::os::unix::net::UnixStream;
            let (mut sender, receiver) = UnixStream::pair().unwrap();
            enable_sender_credentials(&receiver).unwrap();
            sender.write_all(&[1]).unwrap();
            assert!(matches!(
                receive_source_descriptors(&receiver, peer_credentials(&receiver).unwrap()),
                Err(ProtocolError::Request)
            ));
        }

        #[test]
        fn empty_eof_is_not_a_request_or_an_unauthenticated_payload() {
            let (sender, receiver) = UnixStream::pair().unwrap();
            enable_sender_credentials(&receiver).unwrap();
            let peer = peer_credentials(&receiver).unwrap();
            sender.shutdown(std::net::Shutdown::Write).unwrap();
            let (count, files) = receive_message(&receiver, &mut [0], peer, 0).unwrap();
            assert_eq!(count, 0);
            assert!(files.is_empty());
            assert!(matches!(
                receive_source_descriptors(&receiver, peer),
                Err(ProtocolError::Request)
            ));
        }

        #[test]
        fn request_reads_use_one_absolute_deadline() {
            use std::os::unix::net::UnixStream;
            let (mut sender, mut receiver) = UnixStream::pair().unwrap();
            enable_sender_credentials(&receiver).unwrap();
            let peer = peer_credentials(&receiver).unwrap();
            let writer = std::thread::spawn(move || {
                sender.write_all(&[0]).unwrap();
                std::thread::sleep(Duration::from_millis(80));
            });
            let result = read_one_request(
                &mut receiver,
                Instant::now() + Duration::from_millis(20),
                peer,
            );
            writer.join().unwrap();
            assert!(matches!(result, Err(ProtocolError::Transport)));
        }

        #[test]
        fn inherited_socket_cannot_supply_any_request_fragment() {
            // SO_PEERCRED deliberately remains the parent on this socketpair.
            // Fork uses only async-signal-safe syscalls in the child.
            for prefix in [b"".as_slice(), b"\0\0".as_slice(), b"\0\0\0\x04".as_slice()] {
                let (mut sender, receiver) = UnixStream::pair().unwrap();
                receiver.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
                enable_sender_credentials(&receiver).unwrap();
                let parent = peer_credentials(&receiver).unwrap();
                if !prefix.is_empty() {
                    sender.write_all(prefix).unwrap();
                    let mut bytes = vec![0; prefix.len()];
                    assert_eq!(
                        receive_message(&receiver, &mut bytes, parent, 0).unwrap().0,
                        prefix.len()
                    );
                }
                // SAFETY: the child performs write and _exit only.
                let pid = unsafe { libc::fork() };
                assert!(pid >= 0);
                if pid == 0 {
                    unsafe {
                        libc::write(sender.as_raw_fd(), b"x".as_ptr().cast(), 1);
                        libc::_exit(0);
                    }
                }
                let result = receive_message(&receiver, &mut [0; 1], parent, 0);
                // SAFETY: reap only the child created above.
                assert_eq!(unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) }, pid);
                assert_eq!(peer_credentials(&receiver).unwrap(), parent);
                assert!(matches!(result, Err(ProtocolError::UntrustedPeer)));
            }
        }

        #[test]
        fn inherited_socket_cannot_supply_source_descriptors() {
            let (sender, receiver) = UnixStream::pair().unwrap();
            receiver.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
            enable_sender_credentials(&receiver).unwrap();
            let parent = peer_credentials(&receiver).unwrap();
            let file = File::open("/dev/null").unwrap();
            // Construct the message before forking, avoiding allocation in the child.
            let header_length = std::mem::size_of::<ControlHeader>();
            let alignment = std::mem::size_of::<usize>();
            let length = header_length + 3 * std::mem::size_of::<i32>();
            let mut control = vec![0usize; length.div_ceil(alignment)];
            let header = ControlHeader {
                length,
                level: 1,
                kind: 1,
            };
            let descriptors = [file.as_raw_fd(); 3];
            unsafe {
                std::ptr::write(control.as_mut_ptr().cast::<ControlHeader>(), header);
                std::ptr::copy_nonoverlapping(
                    descriptors.as_ptr(),
                    control.as_mut_ptr().cast::<u8>().add(header_length).cast(),
                    3,
                );
            }
            let mut marker = [1u8];
            let mut iov = Iovec {
                base: marker.as_mut_ptr(),
                length: 1,
            };
            let message = MessageHeader {
                name: std::ptr::null_mut(),
                name_length: 0,
                iov: &mut iov,
                iov_length: 1,
                control: control.as_mut_ptr().cast(),
                control_length: control.len() * alignment,
                flags: 0,
            };
            // SAFETY: child sends the prebuilt message and exits without Rust cleanup.
            let pid = unsafe { libc::fork() };
            assert!(pid >= 0);
            if pid == 0 {
                unsafe {
                    libc::sendmsg(
                        sender.as_raw_fd(),
                        (&message as *const MessageHeader).cast(),
                        0,
                    );
                    libc::_exit(0);
                }
            }
            let result = receive_source_descriptors(&receiver, parent);
            assert_eq!(unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) }, pid);
            assert!(matches!(result, Err(ProtocolError::UntrustedPeer)));
        }
    }
}

/// The macOS transport. The root helper is started through the system's own
/// administrator authorisation prompt and listens on a socket in a private
/// directory of the invoking user. It accepts one peer: the invoking user's
/// running application, identified by the kernel audit token of the socket
/// peer and validated by the Security framework against the team requirement.
/// The root command line copies the helper into a root-owned directory and
/// verifies that copy before running it. The helper path is derived from the
/// running application, never taken from the webview.
#[cfg(target_os = "macos")]
pub mod macos_transport {
    use super::*;
    use ais_host_core::release::hex;
    use std::{
        ffi::{c_int, c_void},
        fs::{self, File},
        io::{Read, Write},
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::{FileTypeExt, MetadataExt},
        os::unix::net::{UnixListener, UnixStream},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    const OSASCRIPT_PATH: &str = "/usr/bin/osascript";
    const CODESIGN_PATH: &str = "/usr/bin/codesign";
    const HELPER_NAME: &str = "ais-host-helper";
    const APPLICATION_NAME: &str = "ais-host-app";
    const SOCKET_DIRECTORY: &str = "ais-host-helper";
    const MAX_SOCKET_PATH_BYTES: usize = 100;
    const IO_TIMEOUT: Duration = Duration::from_secs(5);
    const SOURCE_DESCRIPTOR_COUNT: usize = 3;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct Peer {
        pid: u32,
        uid: u32,
        token: [u8; 32],
    }

    type CfRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDataCreate(allocator: CfRef, bytes: *const u8, length: isize) -> CfRef;
        fn CFStringCreateWithCString(allocator: CfRef, text: *const i8, encoding: u32) -> CfRef;
        fn CFDictionaryCreate(
            allocator: CfRef,
            keys: *const CfRef,
            values: *const CfRef,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CfRef;
        fn CFRelease(object: CfRef);
    }

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecGuestAttributeAudit: CfRef;
        fn SecCodeCopyGuestWithAttributes(
            host: CfRef,
            attributes: CfRef,
            flags: u32,
            guest: *mut CfRef,
        ) -> i32;
        fn SecRequirementCreateWithString(text: CfRef, flags: u32, requirement: *mut CfRef) -> i32;
        fn SecCodeCheckValidity(code: CfRef, flags: u32, requirement: CfRef) -> i32;
    }

    pub fn current_uid() -> u32 {
        // SAFETY: getuid has no arguments and cannot fail.
        unsafe { libc::getuid() }
    }

    /// CLOCK_MONOTONIC on macOS keeps counting while the computer sleeps, so a
    /// confirmation still expires across suspend.
    pub fn boottime_ns() -> Result<u64, ProtocolError> {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: value is a valid writable timespec.
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut value) } != 0
            || value.tv_sec < 0
            || value.tv_nsec < 0
        {
            return Err(ProtocolError::Transport);
        }
        (value.tv_sec as u64)
            .checked_mul(1_000_000_000)
            .and_then(|seconds| seconds.checked_add(value.tv_nsec as u64))
            .ok_or(ProtocolError::Transport)
    }

    /// Credentials of the process that owns the other end: uid by getpeereid,
    /// and its audit token, which names one exact process incarnation.
    fn peer_of(stream: &UnixStream) -> Result<Peer, ProtocolError> {
        // LOCAL_PEERTOKEN is not exported by the libc crate.
        const LOCAL_PEERTOKEN: c_int = 0x006;
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: both outputs are valid writable integers.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(ProtocolError::UntrustedPeer);
        }
        let mut pid: c_int = 0;
        let mut length = std::mem::size_of::<c_int>() as libc::socklen_t;
        // SAFETY: pid and length are valid writable buffers for getsockopt.
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut c_int).cast::<c_void>(),
                &mut length,
            )
        };
        let mut token = [0u8; 32];
        let mut token_length = token.len() as libc::socklen_t;
        // SAFETY: token and token_length are valid writable buffers.
        let token_result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast::<c_void>(),
                &mut token_length,
            )
        };
        if result != 0 || pid <= 0 || token_result != 0 || token_length as usize != token.len() {
            return Err(ProtocolError::UntrustedPeer);
        }
        Ok(Peer {
            pid: pid as u32,
            uid,
            token,
        })
    }

    /// True only when the process named by this audit token is validly signed
    /// by a Developer ID certificate of exactly this team. The token fails to
    /// resolve once the process has exec'd, so a descriptor handed on before
    /// an exec cannot borrow the identity of the program it later runs.
    pub(crate) fn peer_satisfies_team(token: &[u8; 32], team: &str) -> bool {
        const UTF8: u32 = 0x0800_0100;
        if team.is_empty() || team.len() > 16 || !team.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return false;
        }
        let Ok(requirement) = std::ffi::CString::new(format!(
            "anchor apple generic and certificate leaf[subject.OU] = \"{team}\""
        )) else {
            return false;
        };
        let mut valid = false;
        // SAFETY: every object created here is released below; the Security and
        // CoreFoundation calls only read the buffers passed to them.
        unsafe {
            let text = CFStringCreateWithCString(std::ptr::null(), requirement.as_ptr(), UTF8);
            let data = CFDataCreate(std::ptr::null(), token.as_ptr(), token.len() as isize);
            let keys = [kSecGuestAttributeAudit];
            let values = [data];
            let attributes = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &raw const kCFTypeDictionaryKeyCallBacks,
                &raw const kCFTypeDictionaryValueCallBacks,
            );
            let mut requirement_ref: CfRef = std::ptr::null();
            let mut guest: CfRef = std::ptr::null();
            if !text.is_null()
                && !data.is_null()
                && !attributes.is_null()
                && SecRequirementCreateWithString(text, 0, &mut requirement_ref) == 0
                && SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes, 0, &mut guest) == 0
            {
                valid = SecCodeCheckValidity(guest, 0, requirement_ref) == 0;
            }
            for object in [guest, requirement_ref, text, data, attributes] {
                if !object.is_null() {
                    CFRelease(object);
                }
            }
        }
        valid
    }

    /// Per-write recheck of the exact peer incarnation.
    pub(crate) fn verify_peer_token(token: &[u8; 32], team: &str) -> Result<(), ProtocolError> {
        if peer_satisfies_team(token, team) {
            Ok(())
        } else {
            Err(ProtocolError::UntrustedPeer)
        }
    }

    /// A listening socket in the invoking user's private directory. Dropping it
    /// unlinks the socket through the retained directory descriptor.
    pub struct Listening {
        pub listener: UnixListener,
        directory: File,
        name: std::ffi::CString,
    }

    impl Drop for Listening {
        fn drop(&mut self) {
            // SAFETY: unlinkat names an entry of the directory we hold open.
            unsafe { libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0) };
        }
    }

    /// Helper side: validate the private directory through one descriptor
    /// opened without following links, then listen on a socket in it. The
    /// socket stays owned by root (no chown into the user's directory); the
    /// directory is the user's, so only that user can reach it.
    pub fn listen_as(socket: &Path, invoking_uid: u32) -> Result<Listening, ProtocolError> {
        use std::os::unix::fs::OpenOptionsExt;
        if invoking_uid == 0 || socket.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
            return Err(ProtocolError::UntrustedPeer);
        }
        let directory = socket.parent().ok_or(ProtocolError::UntrustedPeer)?;
        let name = socket
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| {
                name.ends_with(".sock")
                    && name.len() <= 32
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
            })
            .ok_or(ProtocolError::UntrustedPeer)?;
        let handle = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory)
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        let metadata = handle
            .metadata()
            .map_err(|_| ProtocolError::UntrustedPeer)?;
        if directory.file_name().and_then(|name| name.to_str()) != Some(SOCKET_DIRECTORY)
            || !metadata.is_dir()
            || metadata.uid() != invoking_uid
            || metadata.mode() & 0o077 != 0
        {
            return Err(ProtocolError::UntrustedPeer);
        }
        let name = std::ffi::CString::new(name).map_err(|_| ProtocolError::UntrustedPeer)?;
        // SAFETY: umask only changes this process's creation mask; 0o111 leaves
        // a 0666 socket that the user can connect to.
        let previous = unsafe { libc::umask(0o111) };
        let listener = UnixListener::bind(socket);
        // SAFETY: restores the mask saved above.
        unsafe { libc::umask(previous) };
        let listener = listener.map_err(|_| ProtocolError::Transport)?;
        let listening = Listening {
            listener,
            directory: handle,
            name,
        };
        // The bind went through a path, so confirm through the checked
        // descriptor that the new socket really is an entry of that directory
        // and is ours (root's, in production).
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: valid directory descriptor and name; stat is writable.
        let found = unsafe {
            libc::fstatat(
                listening.directory.as_raw_fd(),
                listening.name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        // SAFETY: fstatat succeeded, so stat is initialised.
        let stat = unsafe { stat.assume_init() };
        // SAFETY: geteuid has no arguments.
        if found != 0
            || stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
            || stat.st_uid != unsafe { libc::geteuid() }
        {
            return Err(ProtocolError::UntrustedPeer);
        }
        listening
            .listener
            .set_nonblocking(true)
            .map_err(|_| ProtocolError::Transport)?;
        Ok(listening)
    }

    fn read_exact_before(
        stream: &mut UnixStream,
        mut buffer: &mut [u8],
        deadline: Instant,
    ) -> Result<(), ProtocolError> {
        while !buffer.is_empty() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|duration| !duration.is_zero())
                .ok_or(ProtocolError::Transport)?;
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|_| ProtocolError::Transport)?;
            let count = stream.read(buffer).map_err(|_| ProtocolError::Transport)?;
            if count == 0 {
                return Err(ProtocolError::Transport);
            }
            buffer = &mut buffer[count..];
        }
        Ok(())
    }

    fn control_space() -> usize {
        let bytes = (SOURCE_DESCRIPTOR_COUNT * std::mem::size_of::<c_int>()) as u32;
        // SAFETY: CMSG_SPACE is pure arithmetic.
        (unsafe { libc::CMSG_SPACE(bytes) }) as usize
    }

    /// The marker byte must arrive with exactly three descriptors and nothing
    /// else attached. Every delivered descriptor is owned immediately, so each
    /// refusal path closes them.
    fn receive_source_descriptors(stream: &UnixStream) -> Result<[File; 3], ProtocolError> {
        let mut marker = [0u8; 1];
        let mut iov = libc::iovec {
            iov_base: marker.as_mut_ptr().cast(),
            iov_len: 1,
        };
        let mut control = vec![0u64; control_space().div_ceil(8)];
        // SAFETY: an all-zero msghdr is a valid empty message header.
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control_space() as libc::socklen_t;
        // SAFETY: message and all referenced storage are live and writable.
        let count = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, 0) };
        let mut files = Vec::new();
        let mut records = 0;
        let mut shape_valid = true;
        // SAFETY: the control buffer was filled by recvmsg and is walked with
        // the platform macros, which stay inside msg_controllen.
        unsafe {
            let mut header = libc::CMSG_FIRSTHDR(&message);
            while !header.is_null() {
                let length = (*header).cmsg_len as usize;
                let data_length = length.saturating_sub(libc::CMSG_LEN(0) as usize);
                if (*header).cmsg_level == libc::SOL_SOCKET
                    && (*header).cmsg_type == libc::SCM_RIGHTS
                    && data_length.is_multiple_of(std::mem::size_of::<c_int>())
                {
                    records += 1;
                    let data = libc::CMSG_DATA(header).cast::<c_int>();
                    for index in 0..data_length / std::mem::size_of::<c_int>() {
                        let descriptor = std::ptr::read_unaligned(data.add(index));
                        if descriptor < 0 {
                            shape_valid = false;
                        } else {
                            libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC);
                            files.push(File::from_raw_fd(descriptor));
                        }
                    }
                } else {
                    shape_valid = false;
                }
                header = libc::CMSG_NXTHDR(&message, header);
            }
        }
        if count != 1
            || marker != [1]
            || message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0
            || records != 1
            || !shape_valid
            || files.len() != SOURCE_DESCRIPTOR_COUNT
        {
            drop(files);
            return Err(ProtocolError::Request);
        }
        files.try_into().map_err(|_| ProtocolError::Request)
    }

    /// Attach exactly three retained source files to a one-byte marker.
    fn send_source_descriptors(
        stream: &UnixStream,
        files: [&File; 3],
    ) -> Result<(), ProtocolError> {
        let mut marker = [1u8];
        let mut iov = libc::iovec {
            iov_base: marker.as_mut_ptr().cast(),
            iov_len: 1,
        };
        let mut control = vec![0u64; control_space().div_ceil(8)];
        // SAFETY: an all-zero msghdr is a valid empty message header.
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control_space() as libc::socklen_t;
        // SAFETY: the control buffer is aligned and large enough for one header
        // and three descriptors; fields are written within its bounds.
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len =
                libc::CMSG_LEN((SOURCE_DESCRIPTOR_COUNT * std::mem::size_of::<c_int>()) as u32)
                    as _;
            let data = libc::CMSG_DATA(header).cast::<c_int>();
            for (index, file) in files.iter().enumerate() {
                std::ptr::write_unaligned(data.add(index), file.as_raw_fd());
            }
        }
        // SAFETY: message and referenced storage are live for the call.
        if unsafe { libc::sendmsg(stream.as_raw_fd(), &message, 0) } == 1 {
            Ok(())
        } else {
            Err(ProtocolError::Transport)
        }
    }

    /// Helper side: accept one connection and authenticate it. The peer must
    /// be a process signed by the team the administrator prompt was started
    /// for; a peer running anything else is refused.
    pub fn authenticate_one(
        listener: &UnixListener,
        invoking_uid: u32,
        team: &str,
    ) -> Result<(AuthenticatedChannel, Request, [File; 3]), ProtocolError> {
        let accept_deadline = Instant::now() + Duration::from_secs(60);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= accept_deadline {
                        return Err(ProtocolError::Transport);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return Err(ProtocolError::Transport),
            }
        };
        stream
            .set_nonblocking(false)
            .and_then(|_| stream.set_read_timeout(Some(IO_TIMEOUT)))
            .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)))
            .map_err(|_| ProtocolError::Transport)?;
        let peer = peer_of(&stream)?;
        if peer.uid != invoking_uid {
            return Err(ProtocolError::UntrustedPeer);
        }
        verify_peer_token(&peer.token, team)?;
        let request_deadline = Instant::now() + IO_TIMEOUT;
        let mut challenge = [0; 32];
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut challenge))
            .map_err(|_| ProtocolError::Transport)?;
        stream
            .write_all(&challenge)
            .map_err(|_| ProtocolError::Transport)?;
        let sources = receive_source_descriptors(&stream)?;
        let mut header = [0; 4];
        read_exact_before(&mut stream, &mut header, request_deadline)?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > MAX_REQUEST_BYTES {
            return Err(ProtocolError::Frame);
        }
        let mut frame = vec![0; 4 + length];
        frame[..4].copy_from_slice(&header);
        read_exact_before(&mut stream, &mut frame[4..], request_deadline)?;
        // The sender half-closes after its one request; anything more is refused.
        let mut trailing = [0; 1];
        let remaining = request_deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or(ProtocolError::Transport)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| ProtocolError::Transport)?;
        if stream
            .read(&mut trailing)
            .map_err(|_| ProtocolError::Transport)?
            != 0
        {
            return Err(ProtocolError::Frame);
        }
        if peer_of(&stream)? != peer {
            return Err(ProtocolError::UntrustedPeer);
        }
        verify_peer_token(&peer.token, team)?;
        let request = decode_frame(&frame)?;
        let now = boottime_ns()?;
        if request.confirmation_deadline_boot_ns <= now
            || request.confirmation_deadline_boot_ns - now > 120_000_000_000
        {
            return Err(ProtocolError::ExpiredOrReplayed);
        }
        let expected = operation_binding(&challenge, &request);
        if hex(&expected) != request.channel_binding {
            return Err(ProtocolError::ExpiredOrReplayed);
        }
        Ok((
            AuthenticatedChannel {
                peer_pid: peer.pid,
                peer_uid: peer.uid,
                request_binding: expected,
                _single_use: (),
                peer_token: peer.token,
                team: team.to_owned(),
            },
            request,
            sources,
        ))
    }

    /// The application and helper are the two executables of one bundle
    /// directory. Both are derived from the running executable.
    fn bundle_paths(running: &Path) -> Result<(PathBuf, PathBuf), ProtocolError> {
        let directory = fs::canonicalize(running)
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?
            .parent()
            .map(Path::to_path_buf)
            .ok_or(ProtocolError::PackageTrustUnavailable)?;
        let (application, helper) = (
            directory.join(APPLICATION_NAME),
            directory.join(HELPER_NAME),
        );
        for path in [&application, &helper] {
            let metadata =
                fs::symlink_metadata(path).map_err(|_| ProtocolError::PackageTrustUnavailable)?;
            if !metadata.is_file() {
                return Err(ProtocolError::PackageTrustUnavailable);
            }
        }
        Ok((application, helper))
    }

    /// The Team ID of a signed executable, or None when it is unsigned or
    /// only ad-hoc signed or fails strict verification.
    fn team_identifier(path: &Path) -> Option<String> {
        let verified = Command::new(CODESIGN_PATH)
            .env_clear()
            .args(["--verify", "--strict"])
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        if !verified.success() {
            return None;
        }
        let details = Command::new(CODESIGN_PATH)
            .env_clear()
            .args(["-d", "--verbose=2"])
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .ok()?;
        parse_team_identifier(&String::from_utf8_lossy(&details.stderr))
    }

    fn parse_team_identifier(details: &str) -> Option<String> {
        details
            .lines()
            .find_map(|line| line.strip_prefix("TeamIdentifier="))
            .map(str::trim)
            .filter(|team| {
                !team.is_empty()
                    && team.len() <= 16
                    && team.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .map(str::to_owned)
    }

    /// The helper may be started only when it and the running application are
    /// both Developer ID signed by the same team.
    fn verify_bundle(running: &Path) -> Result<(PathBuf, PathBuf, String), ProtocolError> {
        let (application, helper) = bundle_paths(running)?;
        match (team_identifier(&application), team_identifier(&helper)) {
            (Some(app), Some(helper_team)) if app == helper_team => Ok((application, helper, app)),
            _ => Err(ProtocolError::PackageTrustUnavailable),
        }
    }

    fn verify_installation() -> Result<(PathBuf, PathBuf, String), ProtocolError> {
        verify_bundle(&std::env::current_exe().map_err(|_| ProtocolError::PackageTrustUnavailable)?)
    }

    /// True only when the signed application and its helper verify.
    pub fn helper_installed() -> bool {
        verify_installation().is_ok()
    }

    /// Runs as root after the prompt. The helper is first copied into a fresh
    /// root-owned directory and that copy, which no user can alter, must satisfy
    /// the team requirement before it runs; the bundle path is never executed.
    /// Every argument is quoted by AppleScript itself, so none is parsed by a
    /// shell. The team was validated as alphanumeric by the caller.
    const ADMINISTRATOR_SCRIPT: &str = r#"on run argv
set helperPath to item 1 of argv
set teamId to item 2 of argv
set helperArguments to ""
repeat with index from 3 to count of argv
set helperArguments to helperArguments & " " & quoted form of (item index of argv)
end repeat
set requirementText to "=anchor apple generic and certificate leaf[subject.OU] = \"" & teamId & "\""
set shellText to "d=$(/usr/bin/mktemp -d /private/var/root/ais-host-helper.XXXXXXXX) || exit 1; /bin/cp " & quoted form of helperPath & " \"$d/helper\" && /usr/bin/codesign --verify --strict -R " & quoted form of requirementText & " \"$d/helper\" && \"$d/helper\"" & helperArguments & "; s=$?; /bin/rm -rf \"$d\"; exit $s"
with timeout of 3600 seconds
do shell script shellText with administrator privileges
end timeout
end run"#;

    /// Run the helper as root through the system administrator prompt.
    fn administrator_command(helper: &Path, team: &str, arguments: &[&str]) -> Command {
        let mut command = Command::new(OSASCRIPT_PATH);
        command
            .arg("-e")
            .arg(ADMINISTRATOR_SCRIPT)
            .arg("--")
            .arg(helper)
            .arg(team)
            .args(arguments)
            .stdin(Stdio::null());
        command
    }

    /// Read-only privileged preview whose single output line is bounded.
    fn preview(flag: &str, identity: &str, limit: usize) -> Result<Vec<u8>, ProtocolError> {
        let (_, helper, team) = verify_installation()?;
        let mut child = administrator_command(&helper, &team, &[flag, identity])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        let mut output = Vec::new();
        let read = child
            .stdout
            .take()
            .ok_or(ProtocolError::Transport)?
            .take(limit as u64 + 1)
            .read_to_end(&mut output);
        let status = child.wait().map_err(|_| ProtocolError::Transport)?;
        if read.is_err() || !status.success() || output.len() > limit {
            return Err(ProtocolError::Transport);
        }
        Ok(output)
    }

    pub fn preview_observation(
        identity: &str,
    ) -> Result<ais_host_core::device::DeviceObservation, ProtocolError> {
        let observation: ais_host_core::device::DeviceObservation =
            serde_json::from_slice(&preview("--preview", identity, 16 * 1024)?)
                .map_err(|_| ProtocolError::Request)?;
        observation.validate().map_err(|_| ProtocolError::Request)?;
        Ok(observation)
    }

    pub fn preview_update(
        identity: &str,
    ) -> Result<ais_host_core::update::DriveSnapshot, ProtocolError> {
        serde_json::from_slice(&preview("--preview-update", identity, 160 * 1024)?)
            .map_err(|_| ProtocolError::Request)
    }

    /// Full privileged session: private socket directory, administrator
    /// prompt, then one request over the helper's socket.
    pub fn run_session(
        invoking_uid: u32,
        files: [&File; 3],
        mut request: Request,
    ) -> Result<(), ProtocolError> {
        use std::os::unix::fs::DirBuilderExt;
        let (_, helper, team) = verify_installation()?;
        let directory = std::env::temp_dir().join(SOCKET_DIRECTORY);
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ProtocolError::UntrustedPeer),
        }
        let directory = fs::canonicalize(&directory).map_err(|_| ProtocolError::UntrustedPeer)?;
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| ProtocolError::UntrustedPeer)?;
        if !metadata.is_dir() || metadata.uid() != invoking_uid || metadata.mode() & 0o077 != 0 {
            return Err(ProtocolError::UntrustedPeer);
        }
        let mut name = [0u8; 8];
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut name))
            .map_err(|_| ProtocolError::Transport)?;
        let socket = directory.join(format!("{}.sock", hex(&name)));
        if socket.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
            return Err(ProtocolError::Transport);
        }
        let _cleanup = RemoveOnDrop(socket.clone());
        let uid = invoking_uid.to_string();
        let socket_argument = socket.to_str().ok_or(ProtocolError::Transport)?;
        let mut child = administrator_command(
            &helper,
            &team,
            &["--serve-as", socket_argument, &uid, &team],
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        // The user may be typing a password, so wait generously for the socket.
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut stream = loop {
            // The helper binds as root; a socket owned by anyone else is a squatter.
            let ready = fs::symlink_metadata(&socket)
                .is_ok_and(|metadata| metadata.file_type().is_socket() && metadata.uid() == 0);
            if ready && let Ok(stream) = UnixStream::connect(&socket) {
                break stream;
            }
            if child
                .try_wait()
                .map_err(|_| ProtocolError::Transport)?
                .is_some()
                || Instant::now() >= deadline
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProtocolError::Transport);
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        // Only the root helper may answer; a socket squatted by the user is refused.
        let (mut euid, mut egid) = (!0, !0);
        // SAFETY: both outputs are valid writable integers.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut euid, &mut egid) } != 0 || euid != 0 {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProtocolError::UntrustedPeer);
        }
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT)))
            .map_err(|_| ProtocolError::Transport)?;
        let mut challenge = [0u8; 32];
        let served = stream
            .read_exact(&mut challenge)
            .map_err(|_| ProtocolError::Transport)
            .and_then(|_| send_source_descriptors(&stream, files))
            .and_then(|_| {
                request.channel_binding = hex(&operation_binding(&challenge, &request));
                let body = serde_json::to_vec(&request).map_err(|_| ProtocolError::Request)?;
                if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
                    return Err(ProtocolError::Frame);
                }
                let mut frame = (body.len() as u32).to_be_bytes().to_vec();
                frame.extend_from_slice(&body);
                stream
                    .write_all(&frame)
                    .and_then(|_| stream.shutdown(std::net::Shutdown::Write))
                    .map_err(|_| ProtocolError::Transport)
            });
        let status = child.wait().map_err(|_| ProtocolError::Transport)?;
        served?;
        if status.success() {
            Ok(())
        } else {
            Err(ProtocolError::Transport)
        }
    }

    struct RemoveOnDrop(PathBuf);

    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn team_identifier_is_read_only_from_a_signed_description() {
            assert_eq!(
                parse_team_identifier("Identifier=x\nTeamIdentifier=ABCDE12345\n").as_deref(),
                Some("ABCDE12345")
            );
            for unsigned in [
                "TeamIdentifier=not set",
                "TeamIdentifier=",
                "Identifier=x",
                "TeamIdentifier=ABCDE12345ABCDE12345",
            ] {
                assert!(parse_team_identifier(unsigned).is_none(), "{unsigned}");
            }
        }

        #[test]
        fn the_bundle_is_the_two_named_executables_of_one_directory() {
            let directory = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("ais-bundle-{}", std::process::id()));
            fs::create_dir_all(&directory).unwrap();
            let running = directory.join(APPLICATION_NAME);
            assert!(bundle_paths(&running).is_err(), "nothing installed");
            fs::write(&running, b"app").unwrap();
            assert!(bundle_paths(&running).is_err(), "helper missing");
            fs::write(directory.join(HELPER_NAME), b"helper").unwrap();
            let (application, helper) = bundle_paths(&running).unwrap();
            assert_eq!(application, running);
            assert_eq!(helper, directory.join(HELPER_NAME));
            // An unsigned bundle never authorises the helper.
            assert!(verify_bundle(&running).is_err());
            let _ = fs::remove_dir_all(&directory);
        }

        #[test]
        fn source_descriptors_round_trip_and_odd_shapes_are_refused() {
            let (sender, receiver) = UnixStream::pair().unwrap();
            let make = |bytes: &[u8]| {
                let path = std::env::temp_dir().join(format!(
                    "ais-fd-{}-{}",
                    std::process::id(),
                    bytes.len()
                ));
                fs::write(&path, bytes).unwrap();
                let file = File::open(&path).unwrap();
                fs::remove_file(&path).unwrap();
                file
            };
            let files = [make(b"one"), make(b"22"), make(b"333")];
            send_source_descriptors(&sender, [&files[0], &files[1], &files[2]]).unwrap();
            let sizes: Vec<u64> = receive_source_descriptors(&receiver)
                .unwrap()
                .iter()
                .map(|file| file.metadata().unwrap().len())
                .collect();
            assert_eq!(sizes, [3, 2, 3]);
            // A bare marker without descriptors is not a source envelope.
            let (mut sender, receiver) = UnixStream::pair().unwrap();
            sender.write_all(&[1]).unwrap();
            assert!(receive_source_descriptors(&receiver).is_err());
        }

        #[test]
        fn peer_credentials_name_this_process_and_its_token_fails_a_foreign_team() {
            // XNU records peer credentials on connect(), not for socketpair().
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("ais-peer-{}-{nanos}.sock", std::process::id()));
            let listener = UnixListener::bind(&path).unwrap();
            let _client = UnixStream::connect(&path).unwrap();
            let (receiver, _) = listener.accept().unwrap();
            let _ = fs::remove_file(&path);
            let peer = peer_of(&receiver).unwrap();
            assert_eq!(peer.uid, current_uid());
            assert_eq!(peer.pid, std::process::id());
            // The test binary is not signed by this team, nor any team at all.
            assert!(!peer_satisfies_team(&peer.token, "ZZZZZZZZZZ"));
            assert!(verify_peer_token(&peer.token, "ZZZZZZZZZZ").is_err());
            // Malformed teams are never interpolated into a requirement.
            for team in ["", "A\" or anchor apple", "a b", &"A".repeat(17)] {
                assert!(!peer_satisfies_team(&peer.token, team));
            }
            // A token that names no process resolves to nothing.
            assert!(!peer_satisfies_team(&[0; 32], "ZZZZZZZZZZ"));
        }

        #[test]
        fn the_administrator_script_verifies_the_copy_before_running_it() {
            let copy = ADMINISTRATOR_SCRIPT.find("/bin/cp").unwrap();
            let verify = ADMINISTRATOR_SCRIPT
                .find("codesign --verify --strict")
                .unwrap();
            let run = ADMINISTRATOR_SCRIPT.rfind("$d/helper").unwrap();
            assert!(copy < verify && verify < run);
            assert!(ADMINISTRATOR_SCRIPT.contains("/private/var/root/"));
            // The bundle path is only ever the source of the copy.
            assert_eq!(
                ADMINISTRATOR_SCRIPT.matches("helperPath").count(),
                2 /* set + copy */
            );
            assert!(
                !ADMINISTRATOR_SCRIPT.contains("set line")
                    && !ADMINISTRATOR_SCRIPT.contains("part")
            );
        }

        #[test]
        fn the_socket_directory_must_be_private_and_owned_by_the_user() {
            let base = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("ais-listen-{}", std::process::id()));
            let directory = base.join(SOCKET_DIRECTORY);
            fs::create_dir_all(&directory).unwrap();
            let socket = directory.join("a.sock");
            fs::set_permissions(
                &directory,
                std::os::unix::fs::PermissionsExt::from_mode(0o755),
            )
            .unwrap();
            assert!(listen_as(&socket, current_uid()).is_err(), "open directory");
            assert!(
                listen_as(&socket, 0).is_err(),
                "root is not an invoking user"
            );
            fs::set_permissions(
                &directory,
                std::os::unix::fs::PermissionsExt::from_mode(0o700),
            )
            .unwrap();
            assert!(
                listen_as(&base.join("elsewhere").join("a.sock"), current_uid()).is_err(),
                "wrong directory name"
            );
            let _listener = listen_as(&socket, current_uid()).unwrap();
            let metadata = fs::symlink_metadata(&socket).unwrap();
            assert!(metadata.file_type().is_socket());
            // Not chowned into the user's directory: 0666 and owned by the binder.
            assert_eq!(metadata.mode() & 0o777, 0o666);
            assert_eq!(metadata.uid(), current_uid());
            drop(_listener);
            assert!(fs::symlink_metadata(&socket).is_err(), "unlinked on drop");
            let _ = fs::remove_dir_all(&base);
        }
    }
}
