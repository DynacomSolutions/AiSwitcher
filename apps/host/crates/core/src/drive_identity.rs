//! Per-creation GPT identities and deterministic ESP personalisation.
use crate::{
    device::DeviceError,
    release::{hex, sha256},
};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Seek, Write};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriveIdentity {
    pub disk: String,
    pub partitions: [String; 5],
}

impl DriveIdentity {
    pub fn fresh() -> Result<Self, DeviceError> {
        fn uuid() -> Result<String, DeviceError> {
            let mut bytes = [0; 16];
            getrandom::fill(&mut bytes).map_err(|_| DeviceError::Entropy)?;
            bytes[6] = (bytes[6] & 15) | 0x40;
            bytes[8] = (bytes[8] & 63) | 0x80;
            let s = hex(&bytes);
            Ok(format!(
                "{}-{}-{}-{}-{}",
                &s[..8],
                &s[8..12],
                &s[12..16],
                &s[16..20],
                &s[20..]
            ))
        }
        let value = Self {
            disk: uuid()?,
            partitions: [uuid()?, uuid()?, uuid()?, uuid()?, uuid()?],
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), DeviceError> {
        let ids: Vec<_> = std::iter::once(&self.disk)
            .chain(&self.partitions)
            .collect();
        for (index, id) in ids.iter().enumerate() {
            gpt_guid(id)?;
            if id.as_bytes()[14] != b'4'
                || !matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
                || ids[..index].contains(id)
            {
                return Err(DeviceError::LayoutUnavailable);
            }
        }
        Ok(())
    }

    /// Connection sequence and device-node names are deliberately absent.
    pub fn record_handle(&self, serial: Option<&str>, model: Option<&str>) -> String {
        let fields = (serial, model, self);
        hex(&sha256(
            &serde_json::to_vec(&fields).expect("identity fields are serialisable"),
        ))[..32]
            .into()
    }
}

pub(crate) fn gpt_guid(uuid: &str) -> Result<[u8; 16], DeviceError> {
    if uuid.len() != 36
        || uuid.bytes().enumerate().any(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b != b'-'
            } else {
                !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err(DeviceError::LayoutUnavailable);
    }
    let plain = uuid.replace('-', "");
    let mut bytes = [0; 16];
    for (index, chunk) in plain.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        bytes[index] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16)
            .map_err(|_| DeviceError::LayoutUnavailable)?;
    }
    bytes[..4].reverse();
    bytes[4..6].reverse();
    bytes[6..8].reverse();
    Ok(bytes)
}

const MENUS: [&str; 2] = ["boot/grub/grub.cfg", "syslinux/syslinux.cfg"];
const MAX_MENU_BYTES: u64 = 256 * 1024;

fn patch_menu(menu: &str, identity: &DriveIdentity) -> Result<String, DeviceError> {
    let mut modes = Vec::new();
    let mut output = String::new();
    for line in menu.lines() {
        let mut words: Vec<_> = line.split_whitespace().collect();
        if matches!(
            words.first(),
            Some(&"linux" | &"linuxefi" | &"append" | &"APPEND")
        ) {
            // Multiline shell commands are outside the reviewed image contract.
            if line.contains(['\\', ';', '"', '\''])
                || (!matches!(words[0], "APPEND" | "append")
                    && words.get(1) != Some(&"/arch/boot/x86_64/vmlinuz-linux"))
                || words.iter().any(|word| {
                    let key = word.split('=').next().unwrap_or_default();
                    (key == *word
                        && [
                            "archisobasedir",
                            "archisodevice",
                            "copytoram",
                            "ais.base",
                            "ais.exchange",
                            "ais.drive",
                        ]
                        .contains(&key))
                        || key.starts_with("cow_")
                        || key.starts_with("img_")
                        || key == "dm_snap_prefix"
                        || (key.starts_with("archiso")
                            && !matches!(key, "archisobasedir" | "archisodevice"))
                        || (key.starts_with("copytoram") && key != "copytoram")
                })
                || words
                    .iter()
                    .filter(|word| word.starts_with("archisobasedir="))
                    .copied()
                    .collect::<Vec<_>>()
                    != ["archisobasedir=arch"]
                || words
                    .iter()
                    .filter(|word| word.starts_with("systemd.firstboot="))
                    .copied()
                    .collect::<Vec<_>>()
                    != ["systemd.firstboot=off"]
            {
                return Err(DeviceError::LayoutUnavailable);
            }
            let mode: Vec<_> = words
                .iter()
                .filter_map(|word| word.strip_prefix("ais.mode="))
                .collect();
            if mode.len() != 1
                || !["latest", "pick", "clean"].contains(&mode[0])
                || modes.contains(&mode[0])
            {
                return Err(DeviceError::LayoutUnavailable);
            }
            modes.push(mode[0]);
            words.retain(|word| {
                ![
                    "ais.base=",
                    "ais.exchange=",
                    "ais.drive=",
                    "archisodevice=",
                    "copytoram=",
                ]
                .iter()
                .any(|key| word.starts_with(key))
            });
            output.push_str(&words.join(" "));
            output.push_str(&format!(
                " ais.base={} ais.exchange={} ais.drive={} archisodevice=/dev/disk/by-partuuid/{} copytoram=n",
                identity.partitions[2], identity.partitions[3], identity.partitions[4], identity.partitions[2]
            ));
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    if modes.len() != 3 {
        return Err(DeviceError::LayoutUnavailable);
    }
    Ok(output)
}

/// FAT operates on a private copy of the authenticated ESP. With chrono
/// disabled its timestamps are deterministic, so helper reconstruction agrees.
pub(crate) fn patch_esp(esp: &[u8], identity: &DriveIdentity) -> Result<Vec<u8>, DeviceError> {
    identity.validate()?;
    let mut bytes = esp.to_vec();
    let result = (|| -> std::io::Result<()> {
        let fs = fatfs::FileSystem::new(Cursor::new(&mut bytes), fatfs::FsOptions::new())?;
        for name in MENUS {
            let mut file = fs.root_dir().open_file(name)?;
            let mut menu = String::new();
            (&mut file)
                .take(MAX_MENU_BYTES + 1)
                .read_to_string(&mut menu)?;
            if menu.len() as u64 > MAX_MENU_BYTES {
                return Err(std::io::Error::other("menu too large"));
            }
            let patched = patch_menu(&menu, identity).map_err(std::io::Error::other)?;
            file.rewind()?;
            file.write_all(patched.as_bytes())?;
            file.truncate()?;
            file.flush()?;
        }
        fs.unmount()?;
        verify_esp(&bytes, identity).map_err(std::io::Error::other)
    })();
    result.map_err(|_| DeviceError::LayoutUnavailable)?;
    Ok(bytes)
}

pub fn verify_esp(esp: &[u8], identity: &DriveIdentity) -> Result<(), DeviceError> {
    identity.validate()?;
    let result = (|| -> std::io::Result<()> {
        let fs = fatfs::FileSystem::new(Cursor::new(esp.to_vec()), fatfs::FsOptions::new())?;
        for name in MENUS {
            let mut menu = String::new();
            fs.root_dir()
                .open_file(name)?
                .take(MAX_MENU_BYTES + 1)
                .read_to_string(&mut menu)?;
            if menu.len() as u64 > MAX_MENU_BYTES
                || patch_menu(&menu, identity).map_err(std::io::Error::other)? != menu
            {
                return Err(std::io::Error::other("boot menu identity mismatch"));
            }
        }
        Ok(())
    })();
    result.map_err(|_| DeviceError::LayoutUnavailable)
}

#[cfg(feature = "file-test")]
pub(crate) fn fixture_esp(bytes: &mut [u8]) {
    fatfs::format_volume(
        Cursor::new(&mut *bytes),
        fatfs::FormatVolumeOptions::new().fat_type(fatfs::FatType::Fat32),
    )
    .unwrap();
    let fs = fatfs::FileSystem::new(Cursor::new(bytes), fatfs::FsOptions::new()).unwrap();
    fs.root_dir().create_dir("boot").unwrap();
    fs.root_dir().create_dir("boot/grub").unwrap();
    fs.root_dir().create_dir("syslinux").unwrap();
    for (name, command) in MENUS
        .into_iter()
        .zip(["linux /arch/boot/x86_64/vmlinuz-linux", "APPEND"])
    {
        let mut file = fs.root_dir().create_file(name).unwrap();
        for mode in ["latest", "pick", "clean"] {
            if command == "APPEND" {
                writeln!(file, "LABEL {mode}\nLINUX /arch/boot/x86_64/vmlinuz-linux").unwrap();
            } else {
                writeln!(file, "menuentry 'AIS {mode}' {{").unwrap();
            }
            writeln!(file, "{command} archisobasedir=arch systemd.firstboot=off ais.mode={mode} ais.base=HOST_APP_REQUIRED ais.exchange=HOST_APP_REQUIRED ais.drive=HOST_APP_REQUIRED archisodevice=/dev/disk/by-partuuid/HOST_APP_REQUIRED copytoram=n").unwrap();
            let initrd = if command == "APPEND" {
                "INITRD"
            } else {
                "initrd"
            };
            writeln!(file, "{initrd} /arch/boot/x86_64/initramfs-linux.img").unwrap();
            if command != "APPEND" {
                writeln!(file, "}}").unwrap();
            }
        }
    }
    fs.unmount().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_unique_and_records_survive_reconnection() {
        let a = DriveIdentity::fresh().unwrap();
        let b = DriveIdentity::fresh().unwrap();
        a.validate().unwrap();
        assert_ne!(a.disk, b.disk);
        for id in &a.partitions {
            assert!(!b.partitions.contains(id));
        }
        let handle = a.record_handle(
            Some("SYNTHETIC_FIXTURE_SERIAL"),
            Some("SYNTHETIC_FIXTURE_MODEL"),
        );
        assert_eq!(
            handle,
            a.clone().record_handle(
                Some("SYNTHETIC_FIXTURE_SERIAL"),
                Some("SYNTHETIC_FIXTURE_MODEL")
            )
        );
        assert_ne!(
            handle,
            b.record_handle(
                Some("SYNTHETIC_FIXTURE_SERIAL"),
                Some("SYNTHETIC_FIXTURE_MODEL")
            )
        );
    }
    #[test]
    fn every_menu_mode_has_exactly_one_of_each_bound_argument() {
        let ids = DriveIdentity::fresh().unwrap();
        let original = ["latest", "pick", "clean"].map(|mode| format!("linux /arch/boot/x86_64/vmlinuz-linux archisobasedir=arch systemd.firstboot=off ais.mode={mode} ais.drive=old ais.drive=duplicate copytoram=y\n")).join("");
        let patched = patch_menu(&original, &ids).unwrap();
        for line in patched.lines() {
            for key in [
                "ais.base=",
                "ais.exchange=",
                "ais.drive=",
                "archisodevice=",
                "copytoram=",
            ] {
                assert_eq!(
                    line.split_whitespace()
                        .filter(|word| word.starts_with(key))
                        .count(),
                    1
                );
            }
            assert!(line.contains(&format!("ais.drive={}", ids.partitions[4])));
            assert!(line.ends_with("copytoram=n"));
        }
    }

    #[test]
    fn unsupported_boot_overrides_are_refused_before_writing() {
        let ids = DriveIdentity::fresh().unwrap();
        let original = ["latest", "pick", "clean"]
            .map(|mode| {
                format!("APPEND archisobasedir=arch systemd.firstboot=off ais.mode={mode}\n")
            })
            .join("");
        for argument in [
            "cow_device=other",
            "img_dev=other",
            "archisolabel=other",
            "archisosearchuuid=other",
            "copytoram_extra=n",
            "dm_snap_prefix=other",
            "extra='quoted'",
            "copytoram",
            "archisodevice",
            "archisobasedir",
            "ais.base",
            "ais.exchange",
            "ais.drive",
        ] {
            let menu = original.replacen("APPEND ", &format!("APPEND {argument} "), 1);
            assert!(patch_menu(&menu, &ids).is_err(), "{argument}");
        }
    }
}
