//! The per-user agent that enforces escrow expiry while the app is closed. It
//! runs the bundled `ais-host-escrow-purge --watch` against the private registry.
//! Nothing here handles a secret; it only writes a service definition and
//! registers it with the user's own service manager (never elevated).

// Windows keeps escrow disabled, so the installer is unused there.
#![cfg_attr(windows, allow(dead_code))]

use std::path::{Path, PathBuf};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LABEL: &str = "invalid.example.ais-host-escrow-purge";

/// Registers the expiry agent. An error means retention must not be offered.
pub trait AgentInstaller: Send + Sync {
    fn ensure_installed(&self, registry: &Path) -> Result<(), String>;
}

fn safe_path(path: &Path) -> Result<&str, String> {
    path.to_str()
        .filter(|text| {
            path.is_absolute()
                && !text
                    .chars()
                    .any(|c| c.is_control() || "\"'%$\\<>&".contains(c))
        })
        .ok_or_else(|| "The agent path is not usable.".to_string())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn launch_agent_plist(binary: &Path, registry: &Path) -> Result<String, String> {
    let (binary, registry) = (safe_path(binary)?, safe_path(registry)?);
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>{LABEL}</string>\n\
<key>ProgramArguments</key><array><string>{binary}</string><string>--watch</string><string>{registry}</string></array>\n\
<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n\
</dict></plist>\n"
    ))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn systemd_unit(binary: &Path, registry: &Path) -> Result<String, String> {
    let (binary, registry) = (safe_path(binary)?, safe_path(registry)?);
    Ok(format!(
        "[Unit]\nDescription=Delete expired ais Host drive passphrases\n\n\
[Service]\nExecStart=\"{binary}\" --watch \"{registry}\"\nRestart=always\nRestartSec=30\n\n\
[Install]\nWantedBy=default.target\n"
    ))
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    let directory = path.parent().ok_or("The agent location is invalid.")?;
    std::fs::create_dir_all(directory).map_err(|_| "The agent folder cannot be created.")?;
    std::fs::write(path, content).map_err(|_| "The agent definition cannot be written.".into())
}

fn run(program: &str, arguments: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(arguments)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub struct NativeAgent {
    pub binary: PathBuf,
    pub home: PathBuf,
}

impl NativeAgent {
    /// The purge binary shipped beside the application executable.
    pub fn bundled() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|_| "The application path is unknown.")?;
        let name = if cfg!(windows) {
            "ais-host-escrow-purge.exe"
        } else {
            "ais-host-escrow-purge"
        };
        let binary = executable
            .parent()
            .map(|dir| dir.join(name))
            .filter(|path| path.is_file())
            .ok_or("The bundled purge agent is missing.")?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("No home directory.")?;
        Ok(Self { binary, home })
    }
}

impl AgentInstaller for NativeAgent {
    #[cfg(target_os = "macos")]
    fn ensure_installed(&self, registry: &Path) -> Result<(), String> {
        let plist = self
            .home
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"));
        write_if_changed(&plist, &launch_agent_plist(&self.binary, registry)?)?;
        // SAFETY: geteuid has no preconditions.
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let service = format!("{domain}/{LABEL}");
        if run("/bin/launchctl", &["print", &service]) {
            return Ok(());
        }
        let plist = safe_path(&plist)?;
        if run("/bin/launchctl", &["bootstrap", &domain, plist]) {
            Ok(())
        } else {
            Err("The expiry agent could not be started.".into())
        }
    }

    #[cfg(target_os = "linux")]
    fn ensure_installed(&self, registry: &Path) -> Result<(), String> {
        let unit = self
            .home
            .join(".config/systemd/user/ais-host-escrow-purge.service");
        write_if_changed(&unit, &systemd_unit(&self.binary, registry)?)?;
        if run("systemctl", &["--user", "daemon-reload"])
            && run(
                "systemctl",
                &["--user", "enable", "--now", "ais-host-escrow-purge.service"],
            )
        {
            Ok(())
        } else {
            Err("The expiry agent could not be started.".into())
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn ensure_installed(&self, _: &Path) -> Result<(), String> {
        Err("Expiry agents are not supported on this platform.".into())
    }
}

#[cfg(all(test, unix))] // unix absolute paths
mod tests {
    use super::*;

    #[test]
    fn definitions_point_at_absolute_paths_and_refuse_unsafe_ones() {
        let (binary, registry) = (
            Path::new("/opt/ais Host/purge"),
            Path::new("/srv/synthetic/data"),
        );
        let plist = launch_agent_plist(binary, registry).unwrap();
        assert!(plist.contains("<string>/opt/ais Host/purge</string><string>--watch</string><string>/srv/synthetic/data</string>"));
        let unit = systemd_unit(binary, registry).unwrap();
        assert!(unit.contains("ExecStart=\"/opt/ais Host/purge\" --watch \"/srv/synthetic/data\""));
        for bad in ["relative/purge", "/a\"b", "/a%h", "/a\nb", "/a<b>"] {
            assert!(launch_agent_plist(Path::new(bad), registry).is_err());
            assert!(systemd_unit(binary, Path::new(bad)).is_err());
        }
    }

    #[test]
    fn writing_is_idempotent() {
        let directory = std::env::temp_dir().join(format!("ais-agent-{}", std::process::id()));
        let file = directory.join("nested/unit");
        write_if_changed(&file, "one").unwrap();
        write_if_changed(&file, "one").unwrap();
        write_if_changed(&file, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
