//! The Windows transport. The application starts the helper elevated through
//! UAC (`runas`) only when a preview or write begins. The helper creates a
//! named pipe whose DACL grants access to the launching user's SID alone and
//! accepts exactly one client: the application executable that sits beside
//! the helper. The application in turn accepts only the process it launched.
//!
//! The pure validators live in `windows_wire` and compile everywhere so they
//! are tested everywhere; the Win32 calls are in `windows_transport`.

/// Pure parts of the Windows transport: names, SIDs, paths and identities.
pub mod windows_wire {
    pub const PIPE_PREFIX: &str = "ais-host-";

    /// `ais-host-` followed by 32 lowercase hexadecimal digits.
    pub fn valid_pipe_name(name: &str) -> bool {
        name.strip_prefix(PIPE_PREFIX).is_some_and(|rest| {
            rest.len() == 32
                && rest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    }

    /// The relative identifier of a user SID string (`S-1-5-21-...-1001`).
    /// Anything that is not a plain user SID, or whose RID is zero, is refused.
    pub fn sid_rid(sid: &str) -> Option<u32> {
        let mut parts = sid.split('-');
        if parts.next() != Some("S") || parts.next() != Some("1") || sid.len() > 100 {
            return None;
        }
        let numbers: Vec<&str> = parts.collect();
        // An authority and at least one sub-authority.
        if numbers.len() < 2
            || numbers.len() > 15
            || numbers.iter().any(|part| {
                part.is_empty() || part.len() > 10 || !part.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return None;
        }
        numbers
            .last()
            .and_then(|rid| rid.parse::<u32>().ok())
            .filter(|rid| *rid != 0)
    }

    pub fn valid_sid(sid: &str) -> bool {
        sid_rid(sid).is_some()
    }

    /// Protected DACL with one entry: generic-all for the given user only.
    pub fn pipe_sddl(sid: &str) -> Option<String> {
        valid_sid(sid).then(|| format!("D:P(A;;GA;;;{sid})"))
    }

    /// The disk number of `windows:PhysicalDriveN`. Digits only, no sign, no
    /// leading zero and at most four digits, so the identity is canonical and
    /// can never name a path.
    pub fn physical_drive_number(identity: &str) -> Option<u32> {
        let digits = identity.strip_prefix("windows:PhysicalDrive")?;
        if digits.is_empty()
            || digits.len() > 4
            || (digits.len() > 1 && digits.starts_with('0'))
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        digits.parse().ok()
    }

    /// Windows paths compare case-insensitively and `\\?\` names the same file.
    pub fn same_path(left: &str, right: &str) -> bool {
        let normal = |path: &str| {
            path.strip_prefix(r"\\?\")
                .unwrap_or(path)
                .replace('/', r"\")
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        };
        let (left, right) = (normal(left), normal(right));
        !left.is_empty() && left == right
    }

    /// Bytes of one whole-sector read that covers `offset..offset + length`:
    /// the aligned start, the window length and the bytes to skip.
    pub fn covering_window(sector: u64, offset: u64, length: usize) -> Option<(u64, usize, usize)> {
        if sector == 0 {
            return None;
        }
        let end = offset.checked_add(length as u64)?;
        let start = offset - offset % sector;
        let window = end.div_ceil(sector).checked_mul(sector)? - start;
        Some((
            start,
            usize::try_from(window).ok()?,
            (offset - start) as usize,
        ))
    }
}

#[cfg(windows)]
pub mod windows_transport {
    use super::super::{
        AuthenticatedChannel, MAX_REQUEST_BYTES, ProtocolError, Request, decode_frame,
        operation_binding,
    };
    use super::windows_wire::{
        PIPE_PREFIX, pipe_sddl, same_path, sid_rid, valid_pipe_name, valid_sid,
    };
    use ais_host_core::release::hex;
    use std::{
        ffi::{OsStr, OsString},
        fs::{File, OpenOptions},
        io::{Read, Seek, SeekFrom, Write},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, RawHandle},
        },
        path::{Path, PathBuf},
        ptr,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ,
            GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_TIMEOUT,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
            GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE,
            FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_ANONYMOUS,
            SECURITY_SQOS_PRESENT,
        },
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
                GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_TYPE_BYTE, PIPE_WAIT,
            },
            SystemInformation::GetTickCount64,
            Threading::{
                GetCurrentProcess, GetExitCodeProcess, GetProcessId, INFINITE, OpenProcess,
                OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                QueryFullProcessImageNameW, WaitForSingleObject,
            },
        },
        UI::{
            Shell::{
                SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    };

    const HELPER_NAME: &str = "ais-host-helper.exe";
    const APPLICATION_NAME: &str = "ais-host-app.exe";
    const PIPE_BUFFER: u32 = 64 * 1024;
    /// The user may be reading the UAC prompt, so wait generously.
    const LAUNCH_TIMEOUT: Duration = Duration::from_secs(120);
    /// Image, checksums and signature, in the order they are sent.
    const MAX_SOURCE_BYTES: [u64; 3] = [2_040_109_465, 1_048_576, 4096];
    const DELETE: u32 = 0x0001_0000;

    /// An owned kernel handle, closed on drop.
    pub struct ProcessHandle(HANDLE);

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            // SAFETY: the handle is owned by this value and closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }

    /// Milliseconds since boot, including time asleep, so a confirmation also
    /// expires while the computer is suspended.
    pub fn boottime_ns() -> Result<u64, ProtocolError> {
        // SAFETY: GetTickCount64 takes no arguments.
        unsafe { GetTickCount64() }
            .checked_mul(1_000_000)
            .ok_or(ProtocolError::Transport)
    }

    fn random<const N: usize>() -> Result<[u8; N], ProtocolError> {
        let mut bytes = [0u8; N];
        // SAFETY: the buffer is writable for N bytes; the system RNG needs no handle.
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                bytes.as_mut_ptr(),
                N as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status == 0 {
            Ok(bytes)
        } else {
            Err(ProtocolError::Transport)
        }
    }

    /// The SID string of the user this process runs as.
    pub fn current_user_sid() -> Result<String, ProtocolError> {
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: the output is a valid handle slot.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(ProtocolError::Transport);
        }
        let token = ProcessHandle(token);
        let mut needed = 0u32;
        // SAFETY: a null buffer of length zero asks for the required size.
        unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
        if needed == 0 || needed > 4096 {
            return Err(ProtocolError::Transport);
        }
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        // SAFETY: the buffer is 8-aligned and at least `needed` bytes.
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(ProtocolError::Transport);
        }
        // SAFETY: the call filled a TOKEN_USER at the start of the aligned buffer.
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        let mut text: *mut u16 = ptr::null_mut();
        // SAFETY: the SID belongs to the buffer above; the output is a valid slot.
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 || text.is_null() {
            return Err(ProtocolError::Transport);
        }
        let mut length = 0;
        // SAFETY: the API returned a NUL-terminated string that LocalFree releases.
        let sid = unsafe {
            while *text.add(length) != 0 {
                length += 1;
            }
            let sid = String::from_utf16(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            sid
        };
        sid.ok()
            .filter(|sid| valid_sid(sid))
            .ok_or(ProtocolError::Transport)
    }

    fn image_path(process: HANDLE) -> Option<PathBuf> {
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        // SAFETY: the buffer and length describe one writable region.
        if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0
        {
            return None;
        }
        Some(PathBuf::from(OsString::from_wide(
            &buffer[..length as usize],
        )))
    }

    /// True while the process is still running and still runs `expected`.
    pub(crate) fn verify_peer(
        process: &ProcessHandle,
        expected: &Path,
    ) -> Result<(), ProtocolError> {
        // SAFETY: the handle is owned and has SYNCHRONIZE access.
        if unsafe { WaitForSingleObject(process.0, 0) } != WAIT_TIMEOUT {
            return Err(ProtocolError::UntrustedPeer);
        }
        match image_path(process.0) {
            Some(image) if same_path(&image.to_string_lossy(), &expected.to_string_lossy()) => {
                Ok(())
            }
            _ => Err(ProtocolError::UntrustedPeer),
        }
    }

    /// The application and helper are the two executables of one directory,
    /// both derived from the running executable.
    fn bundle_paths(running: &Path) -> Result<(PathBuf, PathBuf), ProtocolError> {
        let directory = std::fs::canonicalize(running)
            .map_err(|_| ProtocolError::PackageTrustUnavailable)?
            .parent()
            .map(Path::to_path_buf)
            .ok_or(ProtocolError::PackageTrustUnavailable)?;
        let (application, helper) = (
            directory.join(APPLICATION_NAME),
            directory.join(HELPER_NAME),
        );
        for path in [&application, &helper] {
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|_| ProtocolError::PackageTrustUnavailable)?;
            if !metadata.is_file() {
                return Err(ProtocolError::PackageTrustUnavailable);
            }
        }
        Ok((application, helper))
    }

    fn installation() -> Result<(PathBuf, PathBuf), ProtocolError> {
        bundle_paths(&std::env::current_exe().map_err(|_| ProtocolError::PackageTrustUnavailable)?)
    }

    /// True when the application and its helper sit side by side.
    pub fn helper_installed() -> bool {
        installation().is_ok()
    }

    // ---- helper side -----------------------------------------------------

    /// The helper's end of the pipe, before a client has connected.
    pub struct Listening {
        pipe: HANDLE,
    }

    impl Drop for Listening {
        fn drop(&mut self) {
            // SAFETY: the handle is owned and closed once.
            unsafe { CloseHandle(self.pipe) };
        }
    }

    /// Create the pipe as its first instance, so no one can have squatted the
    /// name, with a DACL that admits only the launching user.
    pub fn listen(name: &str, sid: &str) -> Result<Listening, ProtocolError> {
        if !valid_pipe_name(name) {
            return Err(ProtocolError::UntrustedPeer);
        }
        let sddl = wide(pipe_sddl(sid).ok_or(ProtocolError::UntrustedPeer)?);
        let mut descriptor = ptr::null_mut();
        // SAFETY: the SDDL is NUL-terminated; the descriptor is freed below.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(ProtocolError::Transport);
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let path = wide(format!(r"\\.\pipe\{name}"));
        // SAFETY: the path is NUL-terminated and the attributes outlive the call.
        let pipe = unsafe {
            CreateNamedPipeW(
                path.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER,
                PIPE_BUFFER,
                0,
                &attributes,
            )
        };
        // SAFETY: the descriptor was allocated by the conversion call above.
        unsafe { LocalFree(descriptor.cast()) };
        if pipe == INVALID_HANDLE_VALUE {
            return Err(ProtocolError::Transport);
        }
        Ok(Listening { pipe })
    }

    impl Listening {
        /// Wait for the one client. If none arrives within the launch window
        /// the whole helper exits, so an abandoned elevation never lingers.
        pub fn accept(self) -> Result<(File, u32), ProtocolError> {
            let connected = Arc::new(AtomicBool::new(false));
            let watchdog = Arc::clone(&connected);
            std::thread::spawn(move || {
                std::thread::sleep(LAUNCH_TIMEOUT);
                if !watchdog.load(Ordering::SeqCst) {
                    std::process::exit(77);
                }
            });
            // SAFETY: the pipe handle is valid; no overlapped structure is used.
            let ok = unsafe { ConnectNamedPipe(self.pipe, ptr::null_mut()) } != 0
                // SAFETY: reads the calling thread's last error.
                || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
            if !ok {
                return Err(ProtocolError::Transport);
            }
            connected.store(true, Ordering::SeqCst);
            let mut pid = 0u32;
            // SAFETY: the handle is valid and the output is a writable u32.
            if unsafe { GetNamedPipeClientProcessId(self.pipe, &mut pid) } == 0 || pid == 0 {
                return Err(ProtocolError::UntrustedPeer);
            }
            let pipe = self.pipe;
            std::mem::forget(self);
            // SAFETY: ownership of the pipe handle moves into the File.
            Ok((unsafe { File::from_raw_handle(pipe as RawHandle) }, pid))
        }
    }

    fn open_peer(pid: u32, application: &Path) -> Result<ProcessHandle, ProtocolError> {
        // SAFETY: plain OpenProcess; a null result is refused below.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(ProtocolError::UntrustedPeer);
        }
        let process = ProcessHandle(handle);
        verify_peer(&process, application)?;
        Ok(process)
    }

    fn client_pid(stream: &File) -> Result<u32, ProtocolError> {
        let mut pid = 0u32;
        // SAFETY: the handle belongs to the stream; the output is a writable u32.
        if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle() as HANDLE, &mut pid) } == 0 {
            return Err(ProtocolError::UntrustedPeer);
        }
        Ok(pid)
    }

    /// A private file nobody else can open: exclusive from creation and
    /// deleted when the last handle closes.
    fn private_file() -> Result<File, ProtocolError> {
        let name = random::<8>()?;
        let path = std::env::temp_dir().join(format!("ais-host-source-{}.tmp", hex(&name)));
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(0)
            .attributes(FILE_ATTRIBUTE_TEMPORARY)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
            .open(path)
            .map_err(|_| ProtocolError::Transport)
    }

    /// Image, checksums and signature, each as a big-endian length and its
    /// bytes, copied into private files. Lengths are bounded before any copy.
    fn receive_sources(stream: &mut File) -> Result<[File; 3], ProtocolError> {
        let mut files = Vec::with_capacity(3);
        for maximum in MAX_SOURCE_BYTES {
            let mut length = [0u8; 8];
            stream
                .read_exact(&mut length)
                .map_err(|_| ProtocolError::Transport)?;
            let length = u64::from_be_bytes(length);
            if length == 0 || length > maximum {
                return Err(ProtocolError::Frame);
            }
            let mut file = private_file()?;
            let copied = std::io::copy(&mut Read::take(&mut *stream, length), &mut file)
                .map_err(|_| ProtocolError::Transport)?;
            if copied != length {
                return Err(ProtocolError::Transport);
            }
            file.seek(SeekFrom::Start(0))
                .map_err(|_| ProtocolError::Transport)?;
            files.push(file);
        }
        files.try_into().map_err(|_| ProtocolError::Request)
    }

    /// Helper side: authenticate the client, hand it a challenge, and read
    /// one bound request followed by the retained sources.
    pub fn authenticate_one(
        mut stream: File,
        pid: u32,
        sid: &str,
    ) -> Result<(AuthenticatedChannel, Request, [File; 3]), ProtocolError> {
        let rid = sid_rid(sid).ok_or(ProtocolError::UntrustedPeer)?;
        let (application, _) = bundle_paths(
            &std::env::current_exe().map_err(|_| ProtocolError::PackageTrustUnavailable)?,
        )?;
        let peer = open_peer(pid, &application)?;
        let challenge = random::<32>()?;
        stream
            .write_all(&challenge)
            .map_err(|_| ProtocolError::Transport)?;
        let mut header = [0u8; 4];
        stream
            .read_exact(&mut header)
            .map_err(|_| ProtocolError::Transport)?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > MAX_REQUEST_BYTES {
            return Err(ProtocolError::Frame);
        }
        let mut frame = vec![0u8; 4 + length];
        frame[..4].copy_from_slice(&header);
        stream
            .read_exact(&mut frame[4..])
            .map_err(|_| ProtocolError::Transport)?;
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
        let sources = receive_sources(&mut stream)?;
        if client_pid(&stream)? != pid {
            return Err(ProtocolError::UntrustedPeer);
        }
        verify_peer(&peer, &application)?;
        Ok((
            AuthenticatedChannel {
                peer_pid: pid,
                peer_uid: rid,
                request_binding: expected,
                _single_use: (),
                peer_process: peer,
                peer_image: application,
            },
            request,
            sources,
        ))
    }

    /// Helper side of a read-only preview: authenticate the client by its
    /// process, and only then produce and send the bounded reply.
    pub fn serve_preview(
        name: &str,
        sid: &str,
        produce: impl FnOnce() -> Result<Vec<u8>, &'static str>,
    ) -> Result<(), &'static str> {
        const CHANNEL: &str = "The private helper channel is unavailable.";
        if !valid_sid(sid) {
            return Err(CHANNEL);
        }
        let (mut stream, pid) = listen(name, sid)
            .and_then(Listening::accept)
            .map_err(|_| CHANNEL)?;
        let (application, _) =
            bundle_paths(&std::env::current_exe().map_err(|_| CHANNEL)?).map_err(|_| CHANNEL)?;
        open_peer(pid, &application).map_err(|_| "The application could not be authenticated.")?;
        let bytes = produce()?;
        // Flushing a pipe waits until the client has read everything.
        stream
            .write_all(&bytes)
            .and_then(|_| stream.sync_all())
            .map_err(|_| "The preview could not be reported.")
    }

    // ---- application side ------------------------------------------------

    /// Start the helper elevated. The UAC prompt appears here; declining it
    /// is an error. The returned handle is the launched process itself.
    fn launch_elevated(helper: &Path, arguments: &[&str]) -> Result<ProcessHandle, ProtocolError> {
        let verb = wide("runas");
        let file = wide(helper);
        let parameters = wide(arguments.join(" "));
        // SAFETY: an all-zero SHELLEXECUTEINFOW is valid before the fields are set.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.nShow = SW_HIDE;
        // SAFETY: every string is NUL-terminated and outlives the call.
        if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
            return Err(ProtocolError::PackageTrustUnavailable);
        }
        Ok(ProcessHandle(info.hProcess))
    }

    /// Connect to the pipe and prove the other end is the process we launched,
    /// running the helper executable, before anything is sent. The connection
    /// is made with the anonymous impersonation level.
    fn connect(name: &str, child: &ProcessHandle, helper: &Path) -> Result<File, ProtocolError> {
        let path = wide(format!(r"\\.\pipe\{name}"));
        let deadline = Instant::now() + LAUNCH_TIMEOUT;
        loop {
            // SAFETY: the path is NUL-terminated; no security attributes or template.
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                // SAFETY: ownership of the new handle moves into the File.
                let stream = unsafe { File::from_raw_handle(handle as RawHandle) };
                let mut server = 0u32;
                // SAFETY: valid handles and a writable output.
                let matches = unsafe {
                    GetNamedPipeServerProcessId(handle, &mut server) != 0
                        && server == GetProcessId(child.0)
                };
                if !matches {
                    return Err(ProtocolError::UntrustedPeer);
                }
                verify_peer(child, helper)?;
                return Ok(stream);
            }
            // SAFETY: reads the calling thread's last error.
            let error = unsafe { GetLastError() };
            // Any other error means the name is taken by something else.
            if error != ERROR_FILE_NOT_FOUND && error != ERROR_PIPE_BUSY {
                return Err(ProtocolError::UntrustedPeer);
            }
            // SAFETY: the handle is owned and has SYNCHRONIZE access.
            if unsafe { WaitForSingleObject(child.0, 0) } != WAIT_TIMEOUT
                || Instant::now() >= deadline
            {
                return Err(ProtocolError::Transport);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_success(child: &ProcessHandle) -> Result<(), ProtocolError> {
        let mut code = 1u32;
        // SAFETY: the handle is owned; INFINITE waits for the helper to end.
        let finished = unsafe {
            WaitForSingleObject(child.0, INFINITE);
            GetExitCodeProcess(child.0, &mut code)
        };
        if finished != 0 && code == 0 {
            Ok(())
        } else {
            Err(ProtocolError::Transport)
        }
    }

    fn session_name() -> Result<String, ProtocolError> {
        Ok(format!("{PIPE_PREFIX}{}", hex(&random::<16>()?)))
    }

    /// Read-only elevated preview whose single reply is bounded.
    fn preview(flag: &str, identity: &str, limit: usize) -> Result<Vec<u8>, ProtocolError> {
        let (_, helper) = installation()?;
        let (name, sid) = (session_name()?, current_user_sid()?);
        let child = launch_elevated(&helper, &[flag, &name, &sid, identity])?;
        let stream = connect(&name, &child, &helper);
        let mut output = Vec::new();
        let read = stream.map(|stream| stream.take(limit as u64 + 1).read_to_end(&mut output));
        wait_success(&child)?;
        if !matches!(read, Ok(Ok(_))) || output.len() > limit {
            return Err(ProtocolError::Transport);
        }
        Ok(output)
    }

    pub fn preview_observation(
        identity: &str,
    ) -> Result<ais_host_core::device::DeviceObservation, ProtocolError> {
        let observation: ais_host_core::device::DeviceObservation =
            serde_json::from_slice(&preview("--pipe-preview", identity, 16 * 1024)?)
                .map_err(|_| ProtocolError::Request)?;
        observation.validate().map_err(|_| ProtocolError::Request)?;
        Ok(observation)
    }

    pub fn preview_update(
        identity: &str,
    ) -> Result<ais_host_core::update::DriveSnapshot, ProtocolError> {
        serde_json::from_slice(&preview("--pipe-preview-update", identity, 160 * 1024)?)
            .map_err(|_| ProtocolError::Request)
    }

    /// Full elevated session: UAC prompt, then one bound request and the three
    /// retained sources over the helper's pipe.
    pub fn run_session(files: [&File; 3], mut request: Request) -> Result<(), ProtocolError> {
        let (_, helper) = installation()?;
        let (name, sid) = (session_name()?, current_user_sid()?);
        let child = launch_elevated(&helper, &["--pipe-serve", &name, &sid])?;
        let mut stream = connect(&name, &child, &helper)?;
        let served = (|| {
            let mut challenge = [0u8; 32];
            stream
                .read_exact(&mut challenge)
                .map_err(|_| ProtocolError::Transport)?;
            request.channel_binding = hex(&operation_binding(&challenge, &request));
            let body = serde_json::to_vec(&request).map_err(|_| ProtocolError::Request)?;
            if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
                return Err(ProtocolError::Frame);
            }
            let mut frame = (body.len() as u32).to_be_bytes().to_vec();
            frame.extend_from_slice(&body);
            stream
                .write_all(&frame)
                .map_err(|_| ProtocolError::Transport)?;
            for file in files {
                let length = file.metadata().map_err(|_| ProtocolError::Transport)?.len();
                let mut source = file;
                source
                    .seek(SeekFrom::Start(0))
                    .map_err(|_| ProtocolError::Transport)?;
                stream
                    .write_all(&length.to_be_bytes())
                    .map_err(|_| ProtocolError::Transport)?;
                let copied = std::io::copy(&mut source.take(length), &mut stream)
                    .map_err(|_| ProtocolError::Transport)?;
                if copied != length {
                    return Err(ProtocolError::Transport);
                }
            }
            stream.flush().map_err(|_| ProtocolError::Transport)
        })();
        let status = wait_success(&child);
        served?;
        status
    }
}

#[cfg(test)]
mod tests {
    use super::windows_wire::*;

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";

    #[test]
    fn pipe_names_are_the_fixed_prefix_and_32_lowercase_hex_digits() {
        let good = format!("{PIPE_PREFIX}{}", "0123456789abcdef".repeat(2));
        assert!(valid_pipe_name(&good));
        for bad in [
            "",
            PIPE_PREFIX,
            "ais-host-0123",
            &format!("{PIPE_PREFIX}{}", "0123456789ABCDEF".repeat(2)),
            &format!("{PIPE_PREFIX}{}\\x", "0".repeat(32)),
            &format!("..\\{PIPE_PREFIX}{}", "0".repeat(32)),
            &format!("other-{}", "0".repeat(32)),
        ] {
            assert!(!valid_pipe_name(bad), "{bad}");
        }
    }

    #[test]
    fn only_plain_user_sids_name_the_pipe_owner() {
        assert_eq!(sid_rid(SID), Some(1001));
        assert_eq!(
            pipe_sddl(SID).as_deref(),
            Some("D:P(A;;GA;;;S-1-5-21-1004336348-1177238915-682003330-1001)")
        );
        for bad in [
            "",
            "S-1-5",
            "S-1-5-18-0",
            "S-1-5-21-1-2-3-",
            "S-2-5-21-1-2-3-1001",
            "S-1-5-21-1-2-3-1001)(A;;GA;;;WD",
            "S-1-5-21-1-2-3-4294967296",
            "s-1-5-21-1-2-3-1001",
            "S-1-5-21-1-2-3--1001",
        ] {
            assert!(sid_rid(bad).is_none(), "{bad}");
            assert!(pipe_sddl(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn identities_name_a_disk_number_never_a_path() {
        assert_eq!(physical_drive_number("windows:PhysicalDrive0"), Some(0));
        assert_eq!(physical_drive_number("windows:PhysicalDrive7"), Some(7));
        assert_eq!(
            physical_drive_number("windows:PhysicalDrive1234"),
            Some(1234)
        );
        for bad in [
            "",
            "windows:PhysicalDrive",
            "windows:PhysicalDrive07",
            "windows:PhysicalDrive-1",
            "windows:PhysicalDrive+1",
            "windows:PhysicalDrive12345",
            "windows:PhysicalDrive1\\..\\C:",
            "windows:PhysicalDrive1 ",
            "\\\\.\\PhysicalDrive1",
            "linux:8:0",
            "macos:disk2",
        ] {
            assert!(physical_drive_number(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn executable_paths_match_ignoring_case_prefix_and_slashes() {
        assert!(same_path(
            r"C:\Program Files\Ais\ais-host-app.exe",
            r"\\?\c:\program files\ais\AIS-HOST-APP.EXE"
        ));
        assert!(same_path("C:/Ais/app.exe", r"C:\Ais\app.exe"));
        assert!(!same_path(r"C:\Ais\app.exe", r"C:\Ais\other.exe"));
        assert!(!same_path(r"C:\Ais\app.exe", r"D:\Ais\app.exe"));
        assert!(!same_path("", ""));
    }

    #[test]
    fn raw_disk_reads_cover_whole_sectors() {
        assert_eq!(covering_window(512, 0, 17408), Some((0, 17408, 0)));
        assert_eq!(covering_window(512, 700, 100), Some((512, 512, 188)));
        assert_eq!(covering_window(512, 500, 100), Some((0, 1024, 500)));
        assert_eq!(covering_window(4096, 4096, 1), Some((4096, 4096, 0)));
        assert_eq!(covering_window(0, 0, 1), None);
        assert_eq!(covering_window(512, u64::MAX, 1), None);
    }
}
