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

    /// Rights that let a principal change a file or plant files beside it:
    /// write data / add file, append / add subdirectory, extended attributes,
    /// delete child, write attributes, delete, change DACL, change owner, and
    /// the generic write and all rights.
    pub const WRITE_FILE: u32 = 0x0002
        | 0x0004
        | 0x0010
        | 0x0040
        | 0x0100
        | 0x0001_0000
        | 0x0004_0000
        | 0x0008_0000
        | 0x4000_0000
        | 0x1000_0000;
    /// For directories above the helper's own: adding children there cannot
    /// replace the helper, but deleting entries or changing the ACL can.
    pub const WRITE_ANCESTOR: u32 = 0x0040 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0x1000_0000;

    /// SYSTEM, the Administrators group and TrustedInstaller.
    pub fn is_trusted_principal(sid: &str) -> bool {
        matches!(
            sid,
            "S-1-5-18"
                | "S-1-5-32-544"
                | "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
        )
    }

    /// One access-allowed ACE of a DACL.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Ace {
        pub sid: String,
        pub mask: u32,
        /// Applies to children only, not to the object itself.
        pub inherit_only: bool,
    }

    /// True when only trusted principals own the object and hold any of the
    /// `forbidden` rights on it. Users, Authenticated Users, Everyone,
    /// INTERACTIVE, CREATOR OWNER and the current user are never trusted.
    /// Deny entries are ignored: they cannot make another grant safe.
    pub fn acl_is_protected(owner: &str, aces: &[Ace], forbidden: u32) -> bool {
        is_trusted_principal(owner)
            && aces.iter().all(|ace| {
                ace.inherit_only || ace.mask & forbidden == 0 || is_trusted_principal(&ace.sid)
            })
    }

    /// The system format tool inside the given system directory (the value of
    /// GetSystemDirectoryW). Takes the directory as input so no environment
    /// variable can influence it; a relative directory is refused.
    pub fn format_tool_path(system_directory: &std::path::Path) -> Option<std::path::PathBuf> {
        system_directory
            .is_absolute()
            .then(|| system_directory.join("format").with_extension("com"))
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
        Ace, PIPE_PREFIX, WRITE_ANCESTOR, WRITE_FILE, acl_is_protected, pipe_sddl, same_path,
        sid_rid, valid_pipe_name, valid_sid,
    };
    use ais_host_core::release::hex;
    use std::{
        ffi::{OsStr, OsString},
        fs::{File, OpenOptions},
        io::{Read, Seek, SeekFrom, Write},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
            io::{FromRawHandle, RawHandle},
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
            ACL,
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
            },
            Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
            DACL_SECURITY_INFORMATION, GetAce, GetTokenInformation, OWNER_SECURITY_INFORMATION,
            SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::{
            CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE,
            FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_ANONYMOUS,
            SECURITY_SQOS_PRESENT,
        },
        System::{
            Com::CoTaskMemFree,
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
                FOLDERID_ProgramData, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
                SHGetKnownFolderPath, ShellExecuteExW,
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
        sid_string(user.User.Sid)
            .filter(|sid| valid_sid(sid))
            .ok_or(ProtocolError::Transport)
    }

    /// The string form of a SID, or None when it cannot be converted.
    fn sid_string(sid: *mut std::ffi::c_void) -> Option<String> {
        let mut text: *mut u16 = ptr::null_mut();
        // SAFETY: the caller passes a valid SID; the output is a valid slot.
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
            return None;
        }
        let mut length = 0;
        // SAFETY: the API returned a NUL-terminated string that LocalFree releases.
        unsafe {
            while *text.add(length) != 0 {
                length += 1;
            }
            let sid = String::from_utf16(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            sid.ok()
        }
    }

    /// Owner and allow entries of one file or directory. A missing DACL (full
    /// access for everyone) and any entry kind that is not a plain allow or
    /// deny are reported as unprotected by returning None.
    fn read_acl(path: &Path) -> Option<(String, Vec<Ace>)> {
        let name = wide(path);
        let mut owner: *mut std::ffi::c_void = ptr::null_mut();
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor: *mut std::ffi::c_void = ptr::null_mut();
        // SAFETY: the path is NUL-terminated; the outputs are valid slots.
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 || descriptor.is_null() {
            return None;
        }
        let result = (|| {
            if dacl.is_null() || owner.is_null() {
                return None;
            }
            let owner = sid_string(owner)?;
            // SAFETY: the DACL belongs to the descriptor, which is still alive.
            let count = unsafe { (*dacl).AceCount };
            let mut aces = Vec::new();
            for index in 0..u32::from(count) {
                let mut entry: *mut std::ffi::c_void = ptr::null_mut();
                // SAFETY: the index is below the ACE count of this ACL.
                if unsafe { GetAce(dacl, index, &mut entry) } == 0 || entry.is_null() {
                    return None;
                }
                // SAFETY: every ACE starts with a four-byte header and a mask.
                let (kind, flags, mask) = unsafe {
                    let bytes = entry.cast::<u8>();
                    (
                        *bytes,
                        *bytes.add(1),
                        bytes.add(4).cast::<u32>().read_unaligned(),
                    )
                };
                match kind {
                    // ACCESS_ALLOWED_ACE_TYPE: the SID follows the mask.
                    0 => {
                        // SAFETY: an allowed ACE holds its SID at offset 8.
                        let sid = sid_string(unsafe { entry.cast::<u8>().add(8) }.cast())?;
                        aces.push(Ace {
                            sid,
                            mask,
                            inherit_only: flags & 0x08 != 0,
                        });
                    }
                    // Plain, object and callback denies cannot grant anything.
                    1 | 6 | 10 | 12 => {}
                    // Any other allow-like entry is not understood: unsafe.
                    _ => return None,
                }
            }
            Some((owner, aces))
        })();
        // SAFETY: the descriptor was allocated by GetNamedSecurityInfoW.
        unsafe { LocalFree(descriptor) };
        result
    }

    fn protected(path: &Path, forbidden: u32) -> bool {
        read_acl(path).is_some_and(|(owner, aces)| acl_is_protected(&owner, &aces, forbidden))
    }

    /// The helper runs elevated, so it must come from a location non-admin
    /// code cannot write: the file and its directory (where DLLs would be
    /// searched) refuse every write right to anyone but SYSTEM, Administrators
    /// and TrustedInstaller, and so does the chain above against deleting or
    /// re-permissioning entries. A per-machine installer produces this layout.
    fn verify_protected_install(helper: &Path) -> Result<(), ProtocolError> {
        let helper =
            std::fs::canonicalize(helper).map_err(|_| ProtocolError::PackageTrustUnavailable)?;
        // Win32 form: the verbatim prefix is not accepted by the security API.
        let plain = helper.to_string_lossy();
        let helper = PathBuf::from(plain.strip_prefix(r"\\?\").unwrap_or(&plain));
        let mut ok = protected(&helper, WRITE_FILE);
        for (depth, directory) in helper.ancestors().skip(1).enumerate() {
            let forbidden = if depth == 0 {
                WRITE_FILE
            } else {
                WRITE_ANCESTOR
            };
            ok &= protected(directory, forbidden);
        }
        if ok {
            Ok(())
        } else {
            Err(ProtocolError::PackageTrustUnavailable)
        }
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
        let (application, helper) = bundle_paths(
            &std::env::current_exe().map_err(|_| ProtocolError::PackageTrustUnavailable)?,
        )?;
        verify_protected_install(&helper)?;
        Ok((application, helper))
    }

    /// True when the application and its helper sit side by side in a
    /// location only administrators can write.
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

    /// `%ProgramData%\\ais-host`, from the shell's known-folder API rather than
    /// the user-controlled environment, created with a protected DACL that
    /// admits only SYSTEM and Administrators. An existing directory is used
    /// only if its owner and DACL are that protected.
    fn private_directory() -> Result<PathBuf, ProtocolError> {
        let mut folder: *mut u16 = ptr::null_mut();
        // SAFETY: the output is a valid slot; the API allocates the string.
        let status =
            unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, ptr::null_mut(), &mut folder) };
        if status != 0 || folder.is_null() {
            return Err(ProtocolError::Transport);
        }
        let mut length = 0;
        // SAFETY: the API returned a NUL-terminated string freed by CoTaskMemFree.
        let base = unsafe {
            while *folder.add(length) != 0 {
                length += 1;
            }
            let base = String::from_utf16(std::slice::from_raw_parts(folder, length));
            CoTaskMemFree(folder.cast());
            base
        }
        .map_err(|_| ProtocolError::Transport)?;
        let directory = PathBuf::from(base).join("ais-host");
        if !directory.is_absolute() {
            return Err(ProtocolError::Transport);
        }
        let sddl = wide("D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)");
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
        let path = wide(&directory);
        // SAFETY: the path is NUL-terminated and the attributes outlive the call.
        let created = unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } != 0;
        // SAFETY: the descriptor was allocated by the conversion call above.
        unsafe { LocalFree(descriptor.cast()) };
        // An existing directory could have been made by anyone: check its ACL.
        if created || protected(&directory, WRITE_FILE) {
            Ok(directory)
        } else {
            Err(ProtocolError::Transport)
        }
    }

    /// A private file nobody else can open: exclusive from creation and
    /// deleted when the last handle closes.
    fn private_file() -> Result<File, ProtocolError> {
        let name = random::<8>()?;
        let path = private_directory()?.join(format!("ais-host-source-{}.tmp", hex(&name)));
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

    fn ace(sid: &str, mask: u32) -> Ace {
        Ace {
            sid: sid.into(),
            mask,
            inherit_only: false,
        }
    }

    #[test]
    fn only_admin_owned_and_admin_writable_paths_are_protected() {
        const READ_EXECUTE: u32 = 0x0012_00A9;
        const MODIFY: u32 = 0x0013_01BF;
        let system = "S-1-5-18";
        let admins = "S-1-5-32-544";
        let users = "S-1-5-32-545";
        let program_files = [
            ace(system, 0x001F_01FF),
            ace(admins, 0x001F_01FF),
            ace(users, READ_EXECUTE),
        ];
        assert!(acl_is_protected(admins, &program_files, WRITE_FILE));
        assert!(acl_is_protected(
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
            &program_files,
            WRITE_FILE
        ));
        // Each unsafe principal, and an unsafe owner, makes the path unsafe.
        for who in [
            users,
            "S-1-5-11",
            "S-1-1-0",
            "S-1-5-4",
            "S-1-3-0",
            "S-1-5-21-1-2-3-1001",
        ] {
            let mut acl = program_files.to_vec();
            acl.push(ace(who, MODIFY));
            assert!(!acl_is_protected(admins, &acl, WRITE_FILE), "{who}");
            for single in [0x2, 0x4, 0x40, 0x1_0000, 0x4_0000, 0x8_0000, 0x4000_0000] {
                let acl = [ace(admins, 0x1F_01FF), ace(who, single)];
                assert!(
                    !acl_is_protected(admins, &acl, WRITE_FILE),
                    "{who} {single:#x}"
                );
            }
        }
        assert!(
            !acl_is_protected(users, &program_files, WRITE_FILE),
            "user owner"
        );
        assert!(!acl_is_protected(
            "S-1-5-21-1-2-3-1001",
            &program_files,
            WRITE_FILE
        ));
        // An inherit-only grant does not touch the object itself.
        let mut children_only = program_files.to_vec();
        children_only.push(Ace {
            inherit_only: true,
            ..ace("S-1-5-11", MODIFY)
        });
        assert!(acl_is_protected(admins, &children_only, WRITE_FILE));
        // Above the install directory, adding children (the C:\ root's
        // "create folders" for Authenticated Users) is not a risk, deleting is.
        assert!(acl_is_protected(
            admins,
            &[ace("S-1-5-11", 0x4), ace(admins, 0x1F_01FF)],
            WRITE_ANCESTOR
        ));
        assert!(!acl_is_protected(
            admins,
            &[ace("S-1-5-11", 0x40)],
            WRITE_ANCESTOR
        ));
        assert!(!acl_is_protected(
            admins,
            &[ace("S-1-1-0", 0x4_0000)],
            WRITE_ANCESTOR
        ));
    }

    #[test]
    fn the_format_tool_comes_from_the_given_system_directory_only() {
        use std::path::Path;
        let system = Path::new(if cfg!(windows) {
            r"C:\Windows\System32"
        } else {
            "/windows/system32"
        });
        let tool = format_tool_path(system).unwrap();
        assert_eq!(tool.parent(), Some(system));
        assert_eq!(tool.file_name().unwrap(), concat!("format", ".", "com"));
        assert!(format_tool_path(Path::new("System32")).is_none());
        assert!(format_tool_path(Path::new("")).is_none());
    }

    /// The elevated helper inherits the invoking user's environment, which that
    /// user controls. Its Windows code must not read it, nor use the temp
    /// directory or the current directory, nor search PATH with a bare name.
    #[test]
    fn the_elevated_windows_code_consults_no_user_controlled_location() {
        let sources = [
            ("protocol/windows.rs", include_str!("windows.rs")),
            (
                "platform/windows.rs",
                include_str!("../platform/windows.rs"),
            ),
        ];
        let forbidden = [
            concat!("env", "::var"),
            concat!("temp", "_dir"),
            concat!("current", "_dir"),
            concat!("env", "::vars"),
        ];
        for (name, text) in sources {
            // Only the code before the test module is production code.
            let production = text.split("#[cfg(test)]").next().unwrap();
            for needle in forbidden {
                assert!(!production.contains(needle), "{name} uses {needle}");
            }
        }
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
