use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(77);
    }
}

enum Command {
    Serve(PathBuf),
    Preview(String),
    PreviewUpdate(String),
}

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
                if !socket.is_absolute() || socket.as_os_str().len() > 160 {
                    return Err("The privileged helper invocation is invalid.");
                }
                ais_host_helper::service::run_linux(socket, invoking_uid)
            }
            Command::Preview(identity) => ais_host_helper::service::preview_linux(&identity),
            Command::PreviewUpdate(identity) => {
                ais_host_helper::service::preview_update_linux(&identity)
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
        Err("This operating system has no enabled authenticated helper service.")
    }
}

fn parse_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<Command, &'static str> {
    let mut args = args.into_iter();
    let mode = args.next();
    let value = args
        .next()
        .ok_or("The helper operation argument is missing.")?;
    if args.next().is_some() {
        return Err("Unexpected helper arguments.");
    }
    match mode.as_deref().and_then(|mode| mode.to_str()) {
        Some("--serve") => {
            let socket = PathBuf::from(value);
            if !socket.is_absolute() || socket.as_os_str().len() > 160 {
                return Err("The private helper socket path is invalid.");
            }
            Ok(Command::Serve(socket))
        }
        Some("--preview") | Some("--preview-update") => {
            let identity = value
                .into_string()
                .map_err(|_| "The device identity is invalid.")?;
            if identity.len() > 32 || !identity.starts_with("linux:") {
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
    use super::{Command, parse_args};
    use std::ffi::OsString;

    #[test]
    fn accepts_only_fixed_service_arguments() {
        assert!(matches!(
            parse_args([
                OsString::from("--serve"),
                OsString::from("/run/user/1000/ais-host-helper/request.sock")
            ]),
            Ok(Command::Serve(_))
        ));
        assert!(matches!(
            parse_args([OsString::from("--preview"), OsString::from("linux:8:16")]),
            Ok(Command::Preview(_))
        ));
        for args in [
            vec![OsString::from("createLayout")],
            vec![OsString::from("--serve")],
            vec![OsString::from("--serve"), OsString::from("relative.sock")],
            vec![OsString::from("--preview"), OsString::from("/dev/sda")],
            vec![
                OsString::from("--preview"),
                OsString::from("linux:8:16"),
                OsString::from("--exec"),
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
