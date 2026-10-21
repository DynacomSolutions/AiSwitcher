use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(77);
    }
}

// Windows is driven by the pipe commands alone; the Unix commands stay parsed
// (and tested) there but are never run.
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
        team: String,
    },
    Preview(String),
    PreviewUpdate(String),
    /// Windows: the helper is started elevated through UAC and serves one
    /// client over a pipe it creates for the launching user's SID.
    #[cfg_attr(not(windows), allow(dead_code))]
    Pipe {
        name: String,
        sid: String,
        action: PipeAction,
    },
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq)]
enum PipeAction {
    Serve,
    Preview(String),
    PreviewUpdate(String),
}

/// The native identity scheme this build's helper accepts.
const IDENTITY_PREFIX: &str = if cfg!(target_os = "macos") {
    "macos:"
} else if cfg!(windows) {
    "windows:"
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
            Command::ServeAs { .. } | Command::Pipe { .. } => {
                Err("The privileged helper invocation is invalid.")
            }
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
            Command::ServeAs { socket, uid, team } => {
                ais_host_helper::service::run_macos(socket, uid, &team)
            }
            Command::Preview(identity) => ais_host_helper::service::preview_macos(&identity),
            Command::PreviewUpdate(identity) => {
                ais_host_helper::service::preview_update_macos(&identity)
            }
            Command::Serve(_) | Command::Pipe { .. } => {
                Err("The privileged helper invocation is invalid.")
            }
        }
    }
    #[cfg(windows)]
    {
        use ais_host_helper::service;
        match command {
            Command::Pipe { name, sid, action } => match action {
                PipeAction::Serve => service::run_windows(&name, &sid),
                PipeAction::Preview(identity) => service::preview_windows(&name, &sid, &identity),
                PipeAction::PreviewUpdate(identity) => {
                    service::preview_update_windows(&name, &sid, &identity)
                }
            },
            _ => Err("The privileged helper invocation is invalid."),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = command;
        Err("This operating system has no enabled authenticated helper service.")
    }
}

/// `--pipe-serve NAME SID` and `--pipe-preview[-update] NAME SID IDENTITY`.
/// Every value is validated here, before anything is created.
fn parse_pipe_args(
    mode: &str,
    mut args: impl Iterator<Item = std::ffi::OsString>,
) -> Result<Command, &'static str> {
    use ais_host_helper::protocol::windows_wire::{
        physical_drive_number, valid_pipe_name, valid_sid,
    };
    let name = args.next().and_then(|name| name.into_string().ok());
    let sid = args.next().and_then(|sid| sid.into_string().ok());
    let (Some(name), Some(sid)) = (name, sid) else {
        return Err("Unexpected helper arguments.");
    };
    if !valid_pipe_name(&name) || !valid_sid(&sid) {
        return Err("The private helper pipe is invalid.");
    }
    let action = if mode == "--pipe-serve" {
        PipeAction::Serve
    } else {
        let identity = args
            .next()
            .and_then(|identity| identity.into_string().ok())
            .filter(|identity| physical_drive_number(identity).is_some())
            .ok_or("The device identity is invalid.")?;
        if mode == "--pipe-preview" {
            PipeAction::Preview(identity)
        } else {
            PipeAction::PreviewUpdate(identity)
        }
    };
    if args.next().is_some() {
        return Err("Unexpected helper arguments.");
    }
    Ok(Command::Pipe { name, sid, action })
}

fn parse_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<Command, &'static str> {
    let mut args = args.into_iter();
    let mode = args.next();
    if let Some(mode @ ("--pipe-serve" | "--pipe-preview" | "--pipe-preview-update")) =
        mode.as_deref().and_then(|mode| mode.to_str())
    {
        return parse_pipe_args(mode, args);
    }
    if mode.as_deref().and_then(|mode| mode.to_str()) == Some("--serve-as") {
        let (Some(socket), Some(uid), Some(team), None) =
            (args.next(), args.next(), args.next(), args.next())
        else {
            return Err("Unexpected helper arguments.");
        };
        let socket = PathBuf::from(socket);
        let uid = uid
            .to_str()
            .and_then(|uid| uid.parse::<u32>().ok())
            .filter(|uid| *uid != 0)
            .ok_or("The invoking identity is invalid.")?;
        let team = team
            .into_string()
            .ok()
            .filter(|team| {
                !team.is_empty()
                    && team.len() <= 16
                    && team.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .ok_or("The signing team is invalid.")?;
        if !socket.is_absolute() || socket.as_os_str().len() > MAX_SOCKET_BYTES {
            return Err("The private helper socket path is invalid.");
        }
        return Ok(Command::ServeAs { socket, uid, team });
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
    use super::{Command, IDENTITY_PREFIX, PipeAction, parse_args};
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
                OsString::from("ABCDE12345"),
            ]),
            Ok(Command::ServeAs { uid: 501, .. })
        ));
        let pipe = format!("ais-host-{}", "0123456789abcdef".repeat(2));
        let sid = "S-1-5-21-1004336348-1177238915-682003330-1001";
        let parsed = |args: &[&str]| parse_args(args.iter().map(OsString::from));
        assert!(matches!(
            parsed(&["--pipe-serve", &pipe, sid]),
            Ok(Command::Pipe {
                action: PipeAction::Serve,
                ..
            })
        ));
        assert!(matches!(
            parsed(&["--pipe-preview", &pipe, sid, "windows:PhysicalDrive3"]),
            Ok(Command::Pipe {
                action: PipeAction::Preview(_),
                ..
            })
        ));
        assert!(matches!(
            parsed(&[
                "--pipe-preview-update",
                &pipe,
                sid,
                "windows:PhysicalDrive3"
            ]),
            Ok(Command::Pipe {
                action: PipeAction::PreviewUpdate(_),
                ..
            })
        ));
        for args in [
            // The pipe, the user and the disk are fixed shapes; nothing extra.
            vec!["--pipe-serve"],
            vec!["--pipe-serve", &pipe],
            vec!["--pipe-serve", "evil", sid],
            vec!["--pipe-serve", &pipe, "S-1-1-0"],
            vec!["--pipe-serve", &pipe, sid, "extra"],
            vec!["--pipe-preview", &pipe, sid],
            vec!["--pipe-preview", &pipe, sid, r"\\.\PhysicalDrive3"],
            vec!["--pipe-preview", &pipe, sid, "windows:PhysicalDrive03"],
            vec!["--pipe-preview", &pipe, sid, "windows:PhysicalDrive3", "x"],
        ] {
            assert!(parsed(&args).is_err(), "{args:?}");
        }
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
            // Root is never an invoking user; the team is alphanumeric; nothing extra is accepted.
            vec![
                OsString::from("--serve-as"),
                OsString::from("/var/folders/x/T/ais-host-helper/a.sock"),
                OsString::from("0"),
                OsString::from("ABCDE12345"),
            ],
            vec![
                OsString::from("--serve-as"),
                OsString::from("/var/folders/x/T/ais-host-helper/a.sock"),
                OsString::from("501"),
                OsString::from("ABCDE12345"),
                OsString::from("--exec"),
            ],
            vec![
                OsString::from("--serve-as"),
                OsString::from("/var/folders/x/T/ais-host-helper/a.sock"),
                OsString::from("501"),
                OsString::from("A\" or anchor"),
            ],
            vec![
                OsString::from("--serve-as"),
                OsString::from("relative.sock"),
                OsString::from("501"),
                OsString::from("ABCDE12345"),
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
