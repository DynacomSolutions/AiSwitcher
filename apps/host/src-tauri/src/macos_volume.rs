//! Mounts a drive's exchange partition on macOS with `diskutil`, as the signed-in
//! user. The partition is found by its GPT partition UUID, never by device node,
//! and the mount is verified against that node before use. The plist parsing is
//! platform independent so it is tested everywhere.

use plist::{Dictionary, Value};
use std::path::PathBuf;

const EXCHANGE_LABEL: &str = "AISX";

fn dictionary(bytes: &[u8]) -> Result<Dictionary, String> {
    Value::from_reader(std::io::Cursor::new(bytes))
        .ok()
        .and_then(Value::into_dictionary)
        .ok_or_else(|| "diskutil returned an invalid response.".to_string())
}

/// Device identifiers of AISX-labelled partitions from `diskutil list -plist`.
pub fn exchange_candidates(list: &[u8]) -> Result<Vec<String>, String> {
    let list = dictionary(list)?;
    let mut found = Vec::new();
    for disk in list
        .get("AllDisksAndPartitions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_dictionary)
    {
        for part in disk
            .get("Partitions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_dictionary)
        {
            let label = part.get("VolumeName").and_then(Value::as_string);
            let id = part.get("DeviceIdentifier").and_then(Value::as_string);
            if let (Some(EXCHANGE_LABEL), Some(id)) = (label, id)
                && id.starts_with("disk")
                && id.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                found.push(id.to_owned());
            }
        }
    }
    Ok(found)
}

pub struct PartitionInfo {
    pub node: String,
    pub mount_point: Option<PathBuf>,
}

/// The partition's details when it is the external exFAT partition with this UUID.
pub fn matching_partition(
    info: &[u8],
    partition_uuid: &str,
) -> Result<Option<PartitionInfo>, String> {
    let info = dictionary(info)?;
    let text = |key: &str| info.get(key).and_then(Value::as_string);
    let matches = text("DiskUUID").is_some_and(|uuid| uuid.eq_ignore_ascii_case(partition_uuid))
        && text("FilesystemType") == Some("exfat")
        && info.get("Internal").and_then(Value::as_boolean) == Some(false);
    let Some(node) = text("DeviceNode").filter(|_| matches) else {
        return Ok(None);
    };
    let mount_point = text("MountPoint")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    Ok(Some(PartitionInfo {
        node: node.to_owned(),
        mount_point,
    }))
}

#[cfg(target_os = "macos")]
fn diskutil(arguments: &[&str]) -> Result<Vec<u8>, String> {
    use std::{
        io::Read,
        process::Stdio,
        time::{Duration, Instant},
    };
    let mut child = std::process::Command::new("/usr/sbin/diskutil")
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "diskutil is unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("diskutil output is unavailable.")?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut output)
            .map(|_| output)
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("diskutil refused the request.".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("diskutil did not complete.".into());
            }
        }
    }
    let output = reader
        .join()
        .map_err(|_| "diskutil output is unavailable.")?
        .map_err(|_| "diskutil output is unreadable.")?;
    if output.len() > 1024 * 1024 {
        return Err("diskutil output exceeds its size limit.".into());
    }
    Ok(output)
}

#[cfg(target_os = "macos")]
pub fn mount(partition_uuid: &str) -> Result<crate::flow_volume::MountedVolume, String> {
    let mut found = None;
    for id in exchange_candidates(&diskutil(&["list", "-plist"])?)? {
        if let Some(info) =
            matching_partition(&diskutil(&["info", "-plist", &id])?, partition_uuid)?
        {
            if found.is_some() {
                return Err("More than one drive matches.".into());
            }
            found = Some((id, info));
        }
    }
    let (id, info) = found.ok_or("The drive is not connected.")?;
    let mounted_here = info.mount_point.is_none();
    if mounted_here {
        diskutil(&["mount", &id])?;
    }
    let release_id = id.clone();
    let release = move || {
        if mounted_here {
            let _ = diskutil(&["unmount", &release_id]);
        }
    };
    // From here the guard unmounts on every failure path.
    let mut volume = crate::flow_volume::MountedVolume::new(PathBuf::new(), release);
    let info = matching_partition(&diskutil(&["info", "-plist", &id])?, partition_uuid)?
        .filter(|now| now.node == info.node)
        .ok_or("The exchange partition identity changed.")?;
    let path = info
        .mount_point
        .ok_or("The exchange mount point is unavailable.")?;
    let root = ais_host_core::exchange_root::ExchangeRoot::open_verified(&path, &info.node)?;
    drop(root);
    volume.path = path;
    Ok(volume)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plist(body: &str) -> Vec<u8> {
        format!(r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>{body}</dict></plist>"#).into_bytes()
    }

    #[test]
    fn candidates_are_labelled_partitions_with_plain_identifiers() {
        let list = plist(
            "<key>AllDisksAndPartitions</key><array><dict><key>Partitions</key><array>\
             <dict><key>DeviceIdentifier</key><string>disk4s4</string><key>VolumeName</key><string>AISX</string></dict>\
             <dict><key>DeviceIdentifier</key><string>disk4s5</string><key>VolumeName</key><string>Other</string></dict>\
             <dict><key>DeviceIdentifier</key><string>../x</string><key>VolumeName</key><string>AISX</string></dict>\
             </array></dict></array>",
        );
        assert_eq!(exchange_candidates(&list).unwrap(), ["disk4s4"]);
        assert!(exchange_candidates(b"not a plist").is_err());
    }

    #[test]
    fn a_partition_matches_only_by_uuid_filesystem_and_external_media() {
        let info = |uuid: &str, fs: &str, internal: &str| {
            plist(&format!(
                "<key>DiskUUID</key><string>{uuid}</string><key>FilesystemType</key><string>{fs}</string>\
                 <key>Internal</key><{internal}/><key>DeviceNode</key><string>/dev/disk4s4</string>\
                 <key>MountPoint</key><string>/Volumes/AISX</string>"
            ))
        };
        let found = matching_partition(&info("AAAA-BBBB", "exfat", "false"), "aaaa-bbbb")
            .unwrap()
            .unwrap();
        assert_eq!(found.node, "/dev/disk4s4");
        assert_eq!(found.mount_point.unwrap(), PathBuf::from("/Volumes/AISX"));
        assert!(
            matching_partition(&info("AAAA-CCCC", "exfat", "false"), "aaaa-bbbb")
                .unwrap()
                .is_none()
        );
        assert!(
            matching_partition(&info("AAAA-BBBB", "apfs", "false"), "aaaa-bbbb")
                .unwrap()
                .is_none()
        );
        assert!(
            matching_partition(&info("AAAA-BBBB", "exfat", "true"), "aaaa-bbbb")
                .unwrap()
                .is_none()
        );
    }
}
