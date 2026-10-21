use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(77);
    }
}

#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
enum Command {
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Serve(PathBuf),
    /// macOS: the administrator prompt cannot pass an environment, so the
    /// invoking uid is a fixed argument. The client is derived by the helper.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ServeAs {
        socket: PathBuf,
        uid: u32,
    },
    Preview(String),
    PreviewUpdate(String),
}

/// The native identity scheme this build's helper accepts.
const IDENTITY_PREFIX: &str = if cfg!(target_os = "macos") {
    "macos:"
} else {
    "linux:"
};

/// Unix socket paths are limited to 104 bytes on macOS.
const MAX_SOCKET_BYTES: usize = if cfg!(target_os = "macos") { 100 } else { 160 };

fn run() -> Result<(), &'static str> {
    let command = parse_args(std::env::args_os().skip(1))?;
    #[cfg(target_os = "linux")]
    {
        let invoking_uid = std::env::var("PKEXEC_UID")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or("The polkit invoking identity is unavailable.")?;
        unsafe extern "C" {
            fn geteuid() -> u32;
        }
        // SAFETY: geteuid has no arguments and returns the effective uid.
        if unsafe { geteuid() } != 0 {
            return Err("The privileged helper invocation is invalid.");
        }
        match command {
            Command::Serve(socket) => {
                if !socket.is_absolute() || socket.as_os_str().len() > MAX_SOCKET_BYTES {
                    return Err("The privileged helper invocation is invalid.");
                }
                ais_host_helper::service::run_linux(socket, invoking_uid)
            }
            Command::ServeAs { .. } => Err("The privileged helper invocation is invalid."),
            Command::Preview(identity) => ais_host_helper::service::preview_linux(&identity),
            Command::PreviewUpdate(identity) => {
                ais_host_helper::service::preview_update_linux(&identity)
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: geteuid has no arguments and returns the effective uid.
        if unsafe { libc::geteuid() } != 0 {
            return Err("The privileged helper invocation is invalid.");
        }
        match command {
            Command::ServeAs { socket, uid } => ais_host_helper::service::run_macos(socket, uid),
            Command::Preview(identity) => ais_host_helper::service::preview_macos(&identity),
            Command::PreviewUpdate(identity) => {
                ais_host_helper::service::preview_update_macos(&identity)
            }
            Command::Serve(_) => Err("The privileged helper invocation is invalid."),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = command;
        Err("This operating system has no enabled authenticated helper service.")
    }
}

fn parse_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<Command, &'static str> {
    let mut args = args.into_iter();
    let mode = args.next();
    if mode.as_deref().and_then(|mode| mode.to_str()) == Some("--serve-as") {
        let (Some(socket), Some(uid), None) = (args.next(), args.next(), args.next()) else {
            return Err("Unexpected helper arguments.");
        };
        let socket = PathBuf::from(socket);
        let uid = uid
            .to_str()
            .and_then(|uid| uid.parse::<u32>().ok())
            .filter(|uid| *uid != 0)
            .ok_or("The invoking identity is invalid.")?;
        if !socket.is_absolute() || socket.as_os_str().len() > MAX_SOCKET_BYTES {
            return Err("The private helper socket path is invalid.");
        }
        return Ok(Command::ServeAs { socket, uid });
    }
    let value = args
        .next()
        .ok_or("The helper operation argument is missing.")?;
    if args.next().is_some() {
        return Err("Unexpected helper arguments.");
    }
    match mode.as_deref().and_then(|mode| mode.to_str()) {
        Some("--serve") => {
            let socket = PathBuf::from(value);
            if !socket.is_absolute() || socket.as_os_str().len() > MAX_SOCKET_BYTES {
                return Err("The private helper socket path is invalid.");
            }
            Ok(Command::Serve(socket))
        }
        Some("--preview") | Some("--preview-update") => {
            let identity = value
                .into_string()
                .map_err(|_| "The device identity is invalid.")?;
            if identity.len() > 32 || !identity.starts_with(IDENTITY_PREFIX) {
                return Err("The device identity is invalid.");
            }
            if mode.as_deref().and_then(|value| value.to_str()) == Some("--preview-update") {
                Ok(Command::PreviewUpdate(identity))
            } else {
                Ok(Command::Preview(identity))
            }
        }
        _ => Err("This helper accepts only its fixed native service operations."),
    }
}

#[cfg(test)]
mod tests {
    use super::{Command, IDENTITY_PREFIX, parse_args};
    use std::ffi::OsString;

    #[test]
    fn accepts_only_fixed_service_arguments() {
        // The socket path is only absolute on Unix; the service is Linux-only.
        #[cfg(unix)]
        assert!(matches!(
            parse_args([
                OsString::from("--serve"),
                OsString::from("/run/user/1000/ais-host-helper/request.sock")
            ]),
            Ok(Command::Serve(_))
        ));
        assert!(matches!(
            parse_args([
                OsString::from("--preview"),
                OsString::from(format!("{IDENTITY_PREFIX}8:16"))
            ]),
            Ok(Command::Preview(_))
        ));
        #[cfg(unix)]
        assert!(matches!(
            parse_args([
                OsString::from("--serve-as"),
                OsString::from("/var/folders/x/T/ais-host-helper/a.sock"),
                OsString::from("501"),
            ]),
            Ok(Command::ServeAs { uid: 501, .. })
        ));
        for args in [
            vec![OsString::from("createLayout")],
            vec![OsString::from("--serve")],
            vec![OsString::from("--serve"), OsString::from("relative.sock")],
            vec![OsString::from("--preview"), OsString::from("/dev/sda")],
            vec![
                OsString::from("--preview"),
                OsString::from(format!("{IDENTITY_PREFIX}8:16")),
                OsString::from("--exec"),
            ],
            // Root is never an invoking user, and no pin or extra argument is accepted.
            vec![
                OsString::from("--serve-as"),
                OsString::from("/var/folders/x/T/ais-host-helper/a.sock"),
                OsString::from("0"),
            ],
            vec![
                OsString::from("--serve-as"),
                OsString::from("/var/folders/x/T/ais-host-helper/a.sock"),
                OsString::from("501"),
                OsString::from("a".repeat(64)),
            ],
            vec![
                OsString::from("--serve-as"),
                OsString::from("relative.sock"),
                OsString::from("501"),
            ],
            vec![
                OsString::from("--serve"),
                OsString::from("/run/user/1000/socket"),
                OsString::from("--exec"),
            ],
        ] {
            assert!(parse_args(args).is_err());
        }
    }
}
