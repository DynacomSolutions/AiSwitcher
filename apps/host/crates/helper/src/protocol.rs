//! A bounded request description. Decoding is not authentication or approval.
use ais_host_core::release::PublishedRelease;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use thiserror::Error;

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

/// No public constructor. Only the Linux transport may establish this proof
/// after checking peer credentials, the installed client pin and one request.
pub struct AuthenticatedChannel {
    pub(crate) peer_pid: u32,
    pub(crate) peer_uid: u32,
    pub(crate) request_binding: [u8; 32],
    pub(crate) _single_use: (),
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
        use std::os::unix::fs::MetadataExt;
        let current = File::open(format!("/proc/{}/exe", peer.pid))
            .map_err(|_| ProtocolError::UntrustedPeer)?;
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
        sha256(&binding)
    }

    /// The application sends a one-byte marker with exactly three source files
    /// attached. This keeps source authority in retained descriptors rather
    /// than renderer-controlled paths.
    pub fn receive_source_descriptors(stream: &UnixStream) -> Result<[File; 3], ProtocolError> {
        let mut marker = [0u8; 1];
        let mut iov = Iovec {
            base: marker.as_mut_ptr(),
            length: 1,
        };
        let header_length = std::mem::size_of::<ControlHeader>();
        let descriptor_length = SOURCE_DESCRIPTOR_COUNT * std::mem::size_of::<i32>();
        let alignment = std::mem::size_of::<usize>();
        let control_length = (header_length + descriptor_length + alignment - 1) & !(alignment - 1);
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
        let mut records = 0usize;
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
            records += 1;
            if header.length < header_length {
                rights_shape_valid = false;
                break;
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
        if count != 1
            || marker != [1]
            || message.flags & 0x8 != 0
            || returned_length != allocated_length
            || records != 1
            || rights_records != 1
            || !rights_shape_valid
            || files.len() != SOURCE_DESCRIPTOR_COUNT
        {
            drop(files);
            return Err(ProtocolError::Request);
        }
        files.try_into().map_err(|_| ProtocolError::Request)
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

    fn read_one_request(
        stream: &mut UnixStream,
        deadline: Instant,
    ) -> Result<Vec<u8>, ProtocolError> {
        let mut header = [0; 4];
        read_exact_before(stream, &mut header, deadline)?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > MAX_REQUEST_BYTES {
            return Err(ProtocolError::Frame);
        }
        let mut frame = Vec::with_capacity(4 + length);
        frame.extend_from_slice(&header);
        frame.resize(4 + length, 0);
        read_exact_before(stream, &mut frame[4..], deadline)?;
        let mut trailing = [0; 1];
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or(ProtocolError::Transport)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| ProtocolError::Transport)?;
        match stream.read(&mut trailing) {
            Ok(0) => Ok(frame),
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
        let request_deadline = Instant::now() + IO_TIMEOUT;
        let sources = receive_source_descriptors(&stream)?;
        let mut challenge = [0; 32];
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut challenge))
            .map_err(|_| ProtocolError::Transport)?;
        stream
            .write_all(&challenge)
            .map_err(|_| ProtocolError::Transport)?;
        let frame = read_one_request(&mut stream, request_deadline)?;
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
        send_source_descriptors(stream, files)?;
        let mut challenge = [0u8; 32];
        stream
            .read_exact(&mut challenge)
            .map_err(|_| ProtocolError::Transport)?;
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
            serde_json::from_value(serde_json::json!({
                "version": 1,
                "operation": "createLayout",
                "planDigest": "a".repeat(64),
                "channelBinding": "b".repeat(64),
                "ticket": "c".repeat(64),
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
            let received = receive_source_descriptors(&receiver).unwrap();
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
                let files = receive_source_descriptors(&peer).unwrap();
                peer.write_all(&challenge).unwrap();
                let frame =
                    read_one_request(&mut peer, Instant::now() + Duration::from_secs(2)).unwrap();
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
            sender.write_all(&[1]).unwrap();
            assert!(matches!(
                receive_source_descriptors(&receiver),
                Err(ProtocolError::Request)
            ));
        }

        #[test]
        fn request_reads_use_one_absolute_deadline() {
            use std::os::unix::net::UnixStream;
            let (mut sender, mut receiver) = UnixStream::pair().unwrap();
            let writer = std::thread::spawn(move || {
                sender.write_all(&[0]).unwrap();
                std::thread::sleep(Duration::from_millis(80));
            });
            let result =
                read_one_request(&mut receiver, Instant::now() + Duration::from_millis(20));
            writer.join().unwrap();
            assert!(matches!(result, Err(ProtocolError::Transport)));
        }
    }
}
