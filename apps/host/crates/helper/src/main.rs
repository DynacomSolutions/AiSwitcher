use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(77);
    }
}

fn run() -> Result<(), &'static str> {
    let socket = parse_args(std::env::args_os().skip(1))?;
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
        if unsafe { geteuid() } != 0 || !socket.is_absolute() || socket.as_os_str().len() > 160 {
            return Err("The privileged helper invocation is invalid.");
        }
        ais_host_helper::service::run_linux(socket, invoking_uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = socket;
        Err("This operating system has no enabled authenticated helper service.")
    }
}

fn parse_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<PathBuf, &'static str> {
    let mut args = args.into_iter();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--serve")) {
        return Err("This helper accepts only its fixed native service operation.");
    }
    let socket = PathBuf::from(
        args.next()
            .ok_or("The private helper channel is missing.")?,
    );
    if args.next().is_some() {
        return Err("Unexpected helper arguments.");
    }
    if !socket.is_absolute() || socket.as_os_str().len() > 160 {
        return Err("The private helper socket path is invalid.");
    }
    Ok(socket)
}

#[cfg(test)]
mod tests {
    use super::parse_args;
    use std::ffi::OsString;

    #[test]
    fn accepts_only_fixed_absolute_service_arguments() {
        assert!(
            parse_args([
                OsString::from("--serve"),
                OsString::from("/run/user/1000/ais-host-helper/request.sock")
            ])
            .is_ok()
        );
        for args in [
            vec![OsString::from("createLayout")],
            vec![OsString::from("--serve")],
            vec![OsString::from("--serve"), OsString::from("relative.sock")],
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
