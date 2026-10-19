//! Privileged, one-request operation dispatch. This remains behind the
//! authenticated Linux transport and a fixed executable entry point.

#[cfg(target_os = "linux")]
pub fn run_linux(socket: std::path::PathBuf, invoking_uid: u32) -> Result<(), &'static str> {
    use std::{
        fs,
        os::unix::fs::{FileTypeExt, MetadataExt},
        os::unix::net::UnixStream,
        path::Path,
    };
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    if unsafe { geteuid() } != 0 || !socket.is_absolute() || socket.as_os_str().len() > 160 {
        return Err("The privileged helper invocation is invalid.");
    }
    let expected_parent = Path::new("/run/user")
        .join(invoking_uid.to_string())
        .join("ais-host-helper");
    if socket.parent() != Some(expected_parent.as_path()) {
        return Err("The private helper socket path is invalid.");
    }
    let socket_metadata =
        fs::symlink_metadata(&socket).map_err(|_| "The private helper channel is unavailable.")?;
    if !socket_metadata.file_type().is_socket()
        || socket_metadata.uid() != invoking_uid
        || socket_metadata.mode() & 0o077 != 0
    {
        return Err("The private helper socket is not owned by the invoking user.");
    }
    let stream =
        UnixStream::connect(&socket).map_err(|_| "The private helper channel is unavailable.")?;
    let (channel, request, sources) =
        crate::protocol::linux_transport::authenticate_one(stream, invoking_uid).map_err(
            |_| "The installed application or one-operation request could not be authenticated.",
        )?;
    execute_linux(channel, request, sources)
}

#[cfg(target_os = "linux")]
fn execute_linux(
    channel: crate::protocol::AuthenticatedChannel,
    request: crate::protocol::Request,
    sources: [std::fs::File; 3],
) -> Result<(), &'static str> {
    use ais_host_core::{
        device::WritePlan,
        release::{DownloadedImage, ImageVerifier, PublishedRelease, hex, select_release},
    };
    use std::io::{Read, Seek};

    // The bundled verifier is the production trust root. Missing release key
    // or reviewed image contract terminates before native target opening.
    let verifier =
        ImageVerifier::bundled().map_err(|_| "The bundled image trust anchor is unavailable.")?;
    if channel.peer_uid == 0 || channel.peer_pid == 0 || channel.request_binding == [0; 32] {
        return Err("The authenticated application channel is invalid.");
    }
    if request.operation != crate::protocol::Operation::CreateLayout {
        return Err("This helper operation is not enabled.");
    }
    if request.confirmation_deadline_boot_ns
        <= crate::protocol::linux_transport::boottime_ns()
            .map_err(|_| "The original confirmation has expired.")?
    {
        return Err("The original confirmation has expired.");
    }
    let release: PublishedRelease = request.release;
    let selection = select_release(std::slice::from_ref(&release))
        .map_err(|_| "The published release assets are not selectable.")?;
    let selected_assets = [selection.image(), selection.sums(), selection.signature()];
    for (file, expected) in sources.iter().zip(selected_assets) {
        let metadata = file
            .metadata()
            .map_err(|_| "A retained image source is invalid.")?;
        if !metadata.is_file() {
            return Err("Image inputs must be retained regular files.");
        }
        if metadata.len() != expected.size {
            return Err("A retained source does not match the published asset size.");
        }
    }
    if sources[0]
        .metadata()
        .map_err(|_| "The image source is invalid.")?
        .len()
        > 2_040_109_465
        || sources[1]
            .metadata()
            .map_err(|_| "The checksum source is invalid.")?
            .len()
            > 1_048_576
        || sources[2]
            .metadata()
            .map_err(|_| "The signature source is invalid.")?
            .len()
            > 4096
    {
        return Err("An image source exceeds its permitted size.");
    }
    let mut sources = seal_source_files(sources, selected_assets.map(|asset| asset.size))?;
    let sums_size =
        usize::try_from(selection.sums().size).map_err(|_| "Checksum input is too large.")?;
    let signature_size =
        usize::try_from(selection.signature().size).map_err(|_| "Signature input is too large.")?;
    let mut sums = vec![0; sums_size];
    let mut signature = vec![0; signature_size];
    sources[1]
        .seek(std::io::SeekFrom::Start(0))
        .map_err(|_| "The checksum source could not be rewound.")?;
    sources[2]
        .seek(std::io::SeekFrom::Start(0))
        .map_err(|_| "The signature source could not be rewound.")?;
    sources[1]
        .read_exact(&mut sums)
        .map_err(|_| "The checksum source could not be read.")?;
    sources[2]
        .read_exact(&mut signature)
        .map_err(|_| "The signature source could not be read.")?;
    sources[0]
        .seek(std::io::SeekFrom::Start(0))
        .map_err(|_| "The image source could not be rewound.")?;
    let downloaded = DownloadedImage {
        source: sources[0]
            .try_clone()
            .map_err(|_| "The image source could not be retained.")?,
        image_identity: selection.image().clone(),
        sums_identity: selection.sums().clone(),
        signature_identity: selection.signature().clone(),
        sums,
        signature,
    };
    let mut image = verifier
        .verify(&selection, downloaded)
        .map_err(|_| "The source image did not pass bundled trust verification.")?;
    let discovered = crate::platform::collect_linux_by_identity(&request.device_identity)
        .map_err(|_| "The native target could not be re-observed.")?;
    let plan = WritePlan::create_layout(&image, discovered.observation.clone())
        .map_err(|_| "A native write plan could not be reconstructed.")?;
    if hex(&plan.digest()) != request.plan_digest {
        return Err("The app and helper write plans do not match.");
    }
    plan.revalidate(&discovered.observation, &image)
        .map_err(|_| "The native target changed during plan verification.")?;

    let target =
        crate::platform::LinuxBlockTarget::open_authenticated(&channel, &discovered.observation)
            .map_err(|_| "The retained native target could not be opened safely.")?;
    write_confirmed(
        target,
        request.confirmation_deadline_boot_ns,
        &mut image,
        &plan,
        &request.typed_confirmation,
    )
    .map(|_| ())
}

/// Final stage shared by the production block device and loop-file tests. The
/// helper issues its own ticket, capped by the app's original CLOCK_BOOTTIME
/// deadline, and then hands the already-open target to the shared writer.
#[cfg(target_os = "linux")]
pub fn write_confirmed<T: ais_host_core::device::WriteTarget>(
    target: T,
    deadline: u64,
    image: &mut ais_host_core::release::VerifiedImage,
    plan: &ais_host_core::device::WritePlan,
    typed_confirmation: &str,
) -> Result<u64, &'static str> {
    use ais_host_core::device::{ConfirmationBook, write_image};
    use std::time::{Duration, Instant};

    let now_boot = crate::protocol::linux_transport::boottime_ns()
        .map_err(|_| "The original confirmation deadline could not be checked.")?;
    let remaining = deadline
        .checked_sub(now_boot)
        .ok_or("The original confirmation has expired.")?;
    if remaining == 0 || remaining > 120_000_000_000 {
        return Err("The original confirmation is expired or outside its permitted lifetime.");
    }
    let mut target = BootDeadlineTarget {
        target,
        deadline,
        first_write_pending: true,
    };
    let mut approvals = ConfirmationBook::default();
    let ticket = approvals
        .issue(
            plan,
            typed_confirmation,
            Instant::now(),
            Duration::from_nanos(remaining),
        )
        .map_err(|_| "The exact typed confirmation did not match the native plan.")?;
    write_image(&mut target, image, plan, &mut approvals, &ticket, || false)
        .map_err(|_| "The shared writer refused the native operation.")
}

#[cfg(target_os = "linux")]
fn seal_source_files(
    mut sources: [std::fs::File; 3],
    sizes: [u64; 3],
) -> Result<[std::fs::File; 3], &'static str> {
    use std::{
        io::{Read, Seek, SeekFrom, Write},
        os::fd::{AsRawFd, FromRawFd},
    };
    unsafe extern "C" {
        fn memfd_create(name: *const std::ffi::c_char, flags: u32) -> i32;
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    let name = std::ffi::CString::new("ais-host-source").expect("static name");
    let mut sealed = Vec::with_capacity(3);
    for (source, size) in sources.iter_mut().zip(sizes) {
        let metadata = source
            .metadata()
            .map_err(|_| "A retained image source is invalid.")?;
        if !metadata.is_file() || metadata.len() != size || size == 0 {
            return Err("A retained source does not match the published asset size.");
        }
        let descriptor = unsafe { memfd_create(name.as_ptr(), 0x0001 | 0x0002) };
        if descriptor < 0 {
            return Err("A sealed source copy could not be created.");
        }
        // SAFETY: memfd_create returned a new owned descriptor.
        let mut destination = unsafe { std::fs::File::from_raw_fd(descriptor) };
        source
            .seek(SeekFrom::Start(0))
            .map_err(|_| "A retained source could not be rewound.")?;
        let mut remaining = size;
        let mut buffer = [0u8; 64 * 1024];
        while remaining > 0 {
            let count = usize::try_from(remaining.min(buffer.len() as u64))
                .map_err(|_| "A retained source size is invalid.")?;
            source
                .read_exact(&mut buffer[..count])
                .map_err(|_| "A retained source could not be copied.")?;
            destination
                .write_all(&buffer[..count])
                .map_err(|_| "A sealed source copy could not be written.")?;
            remaining -= count as u64;
        }
        let mut extra = [0u8; 1];
        if source
            .read(&mut extra)
            .map_err(|_| "A retained source could not be checked.")?
            != 0
        {
            return Err("A retained source changed while it was copied.");
        }
        // F_ADD_SEALS, F_SEAL_SEAL|SHRINK|GROW|WRITE.
        if unsafe {
            fcntl(
                destination.as_raw_fd(),
                1033,
                0x0001 | 0x0002 | 0x0004 | 0x0008,
            )
        } != 0
        {
            return Err("A sealed source copy could not be made immutable.");
        }
        destination
            .seek(SeekFrom::Start(0))
            .map_err(|_| "A sealed source could not be rewound.")?;
        sealed.push(destination);
    }
    sealed
        .try_into()
        .map_err(|_| "A sealed source set is incomplete.")
}

#[cfg(target_os = "linux")]
struct BootDeadlineTarget<T> {
    target: T,
    deadline: u64,
    first_write_pending: bool,
}

#[cfg(target_os = "linux")]
impl<T: std::io::Read> std::io::Read for BootDeadlineTarget<T> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.target.read(buffer)
    }
}

#[cfg(target_os = "linux")]
impl<T: std::io::Write> std::io::Write for BootDeadlineTarget<T> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.first_write_pending {
            if crate::protocol::linux_transport::boottime_ns()
                .map_err(|_| std::io::Error::other("clock unavailable"))?
                >= self.deadline
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "confirmation expired",
                ));
            }
            let written = self.target.write(buffer)?;
            if written > 0 {
                self.first_write_pending = false;
            }
            return Ok(written);
        }
        self.target.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.target.flush()
    }
}

#[cfg(target_os = "linux")]
impl<T: std::io::Seek> std::io::Seek for BootDeadlineTarget<T> {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.target.seek(position)
    }
}

#[cfg(target_os = "linux")]
impl<T: ais_host_core::device::WriteTarget> ais_host_core::device::WriteTarget
    for BootDeadlineTarget<T>
{
    fn observe(&self) -> std::io::Result<ais_host_core::device::DeviceObservation> {
        self.target.observe()
    }
    fn lock_exclusive(&mut self) -> std::io::Result<()> {
        self.target.lock_exclusive()
    }
    fn flush_durable(&mut self) -> std::io::Result<()> {
        self.target.flush_durable()
    }
    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
        self.target.read_at(offset, buffer)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::BootDeadlineTarget;
    use ais_host_core::device::{DeviceObservation, WriteTarget};
    use std::{io, io::Cursor, io::Read, io::Seek, io::SeekFrom, io::Write};

    struct FakeTarget(Cursor<Vec<u8>>);

    impl Read for FakeTarget {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.0.read(buffer)
        }
    }

    impl Write for FakeTarget {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.write(buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    impl Seek for FakeTarget {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.0.seek(position)
        }
    }

    impl WriteTarget for FakeTarget {
        fn observe(&self) -> io::Result<DeviceObservation> {
            Err(io::Error::other("synthetic observation unavailable"))
        }

        fn lock_exclusive(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn flush_durable(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn original_deadline_is_enforced_at_first_mutation_only() {
        let now = crate::protocol::linux_transport::boottime_ns().unwrap();
        let mut target = BootDeadlineTarget {
            target: FakeTarget(Cursor::new(Vec::new())),
            deadline: now + 2_000_000_000,
            first_write_pending: true,
        };
        assert_eq!(target.write(b"first").unwrap(), 5);
        assert!(!target.first_write_pending);
        target.deadline = 1;
        assert_eq!(target.write(b"second").unwrap(), 6);
        assert_eq!(target.target.0.get_ref(), b"firstsecond");
    }

    #[test]
    fn expired_original_deadline_refuses_before_first_mutation() {
        let mut target = BootDeadlineTarget {
            target: FakeTarget(Cursor::new(Vec::new())),
            deadline: 1,
            first_write_pending: true,
        };
        assert_eq!(
            target.write(b"forbidden").unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(target.target.0.get_ref().is_empty());
    }
}
