// shortcut: the native write path is unwired until this platform's helper authentication lands; drop the allow then.
#![allow(dead_code)]
//! Windows disk identity parsing and retained-handle adapter.
//!
//! Disk mutation is fail-closed until the packaged helper can prove its
//! authenticated pipe peer and bind the approved observation to the current
//! PnP connection generation. Native observation uses direct Windows APIs.
//! The retained-handle writer remains reachable only through the authenticated
//! channel.

use ais_host_core::{device::DeviceObservation, release::sha256};
use serde::Deserialize;

pub(super) const REASON: &str = "Windows native observation is fail-closed until authenticated UAC pipe packaging and a cross-process PnP arrival-generation proof are available.";

const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_ANCESTRY_NODES: usize = 64;
const MAX_VOLUMES: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowsDiskSnapshot {
    pub disk_number: u32,
    pub capacity_bytes: u64,
    pub sector_bytes: u32,
    pub usb_transport: bool,
    /// `STORAGE_DEVICE_DESCRIPTOR.RemovableMedia` describes media, not USB
    /// ancestry. It remains a conservative eligibility requirement, so some
    /// USB disks that report fixed media will be refused.
    pub removable: bool,
    pub internal: bool,
    pub system_backing: bool,
    pub ancestry_complete: bool,
    pub writable: bool,
    pub serial: Option<String>,
    /// Incarnation from a continuously subscribed PnP observer. Windows has
    /// no documented reliable last-arrival property, so absence is ineligible.
    pub connection_generation: Option<String>,
    pub pnp_ancestry: Vec<String>,
    pub volume_ids: Vec<String>,
    pub table_fingerprint: String,
    pub mount_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowsDiskObservation {
    pub observation: DeviceObservation,
    pub disk_number: u32,
    pub volume_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationError {
    InvalidInput,
    Changed,
    Ineligible,
    NativeUnavailable,
}

/// Parse a bounded synthetic/native snapshot document. Unknown fields and
/// ambiguous ancestry are rejected instead of being treated as non-system.
pub fn parse_windows_snapshot(input: &str) -> Result<WindowsDiskSnapshot, ObservationError> {
    if input.is_empty() || input.len() > MAX_SNAPSHOT_BYTES {
        return Err(ObservationError::InvalidInput);
    }
    let snapshot: WindowsDiskSnapshot =
        serde_json::from_str(input).map_err(|_| ObservationError::InvalidInput)?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub fn observe_windows_snapshot(
    snapshot: &WindowsDiskSnapshot,
) -> Result<WindowsDiskObservation, ObservationError> {
    validate_snapshot(snapshot)?;
    let table_fingerprint = parse_digest(&snapshot.table_fingerprint)?;
    let mount_fingerprint = parse_digest(&snapshot.mount_fingerprint)?;
    let ancestry_material = snapshot.pnp_ancestry.join("\0");
    let ancestry_fingerprint = sha256(ancestry_material.as_bytes());
    let mut connection = Vec::new();
    connection.extend_from_slice(
        snapshot
            .serial
            .as_deref()
            .unwrap_or("serial-unavailable")
            .as_bytes(),
    );
    connection.push(0);
    connection.extend_from_slice(
        snapshot
            .connection_generation
            .as_deref()
            .ok_or(ObservationError::Ineligible)?
            .as_bytes(),
    );
    connection.push(0);
    connection.extend_from_slice(ancestry_material.as_bytes());
    connection.push(0);
    connection.extend_from_slice(&snapshot.capacity_bytes.to_be_bytes());
    let observation = DeviceObservation {
        os_identity: format!("windows:PhysicalDrive{}", snapshot.disk_number),
        connection_identity: hex_bytes(&sha256(&connection)),
        display_identifier: format!("PhysicalDrive{}", snapshot.disk_number),
        serial: snapshot.serial.clone(),
        model: None,
        capacity_bytes: snapshot.capacity_bytes,
        sector_bytes: snapshot.sector_bytes,
        table_fingerprint,
        ancestry_fingerprint,
        mount_fingerprint,
        external_usb: snapshot.usb_transport && snapshot.removable,
        internal: snapshot.internal,
        system_backing: snapshot.system_backing,
        ancestry_complete: snapshot.ancestry_complete,
        writable: snapshot.writable,
    };
    observation
        .validate()
        .map_err(|_| ObservationError::Ineligible)?;
    Ok(WindowsDiskObservation {
        observation,
        disk_number: snapshot.disk_number,
        volume_ids: snapshot.volume_ids.clone(),
    })
}

/// Compare native evidence across a planned write phase. The table fingerprint
/// is checked by the shared core against its phase-specific planned transition;
/// physical identity, ancestry and mounts must remain unchanged.
pub fn recheck_windows_snapshot(
    approved: &WindowsDiskSnapshot,
    current: &WindowsDiskSnapshot,
) -> Result<(), ObservationError> {
    validate_snapshot(approved)?;
    validate_snapshot(current)?;
    let prior = observe_windows_snapshot(approved)?;
    let fresh = observe_windows_snapshot(current)?;
    if !prior.observation.same_physical_identity(&fresh.observation)
        || prior.observation.mount_fingerprint != fresh.observation.mount_fingerprint
        || prior.disk_number != fresh.disk_number
        || prior.volume_ids != fresh.volume_ids
        || approved.pnp_ancestry != current.pnp_ancestry
    {
        return Err(ObservationError::Changed);
    }
    Ok(())
}

pub fn collect_windows_snapshot(disk_number: u32) -> Result<WindowsDiskSnapshot, ObservationError> {
    #[cfg(windows)]
    {
        native_observation::collect_snapshot(disk_number)
    }
    #[cfg(not(windows))]
    {
        let _ = disk_number;
        Err(ObservationError::NativeUnavailable)
    }
}

fn validate_snapshot(snapshot: &WindowsDiskSnapshot) -> Result<(), ObservationError> {
    if snapshot.capacity_bytes == 0
        // The shared writer's approved GPT/MBR fingerprint window is defined
        // in 512-byte logical sectors. Refuse devices whose geometry cannot
        // match that contract until the core supports them explicitly.
        || snapshot.sector_bytes != 512
        || !snapshot.capacity_bytes.is_multiple_of(u64::from(snapshot.sector_bytes))
        || snapshot.pnp_ancestry.is_empty()
        || snapshot.pnp_ancestry.len() > MAX_ANCESTRY_NODES
        || snapshot.pnp_ancestry.iter().any(|node| {
            node.is_empty() || node.len() > 1024 || node.chars().any(char::is_control)
        })
        || snapshot.connection_generation.as_ref().is_none_or(|generation| {
            generation.is_empty()
                || generation.len() > 256
                || generation.chars().any(char::is_control)
        })
        || !strictly_unique(&snapshot.pnp_ancestry)
        || snapshot.volume_ids.len() > MAX_VOLUMES
        || snapshot.volume_ids.iter().any(|volume| !valid_volume_id(volume))
        || !strictly_unique(&snapshot.volume_ids)
    {
        return Err(ObservationError::InvalidInput);
    }
    parse_digest(&snapshot.table_fingerprint)?;
    parse_digest(&snapshot.mount_fingerprint)?;
    if let Some(serial) = &snapshot.serial
        && (serial.is_empty() || serial.len() > 256 || serial.chars().any(char::is_control))
    {
        return Err(ObservationError::InvalidInput);
    }
    if !snapshot.ancestry_complete {
        return Err(ObservationError::Ineligible);
    }
    if !snapshot.usb_transport
        || !snapshot.removable
        || snapshot.internal
        || snapshot.system_backing
    {
        return Err(ObservationError::Ineligible);
    }
    Ok(())
}

fn valid_volume_id(volume: &str) -> bool {
    // Volume GUID paths are generated by native enumeration, never from the UI.
    let Some(guid) = volume
        .strip_prefix(r"\\?\Volume{")
        .and_then(|value| value.strip_suffix(r"}\"))
    else {
        return false;
    };
    guid.len() == 36
        && guid.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn strictly_unique<T: Eq>(items: &[T]) -> bool {
    (0..items.len()).all(|index| items[index + 1..].iter().all(|item| item != &items[index]))
}

fn parse_digest(value: &str) -> Result<[u8; 32], ObservationError> {
    if value.len() != 64 {
        return Err(ObservationError::InvalidInput);
    }
    let mut digest = [0; 32];
    for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let high = hex(pair[0]).ok_or(ObservationError::InvalidInput)?;
        let low = hex(pair[1]).ok_or(ObservationError::InvalidInput)?;
        digest[index] = (high << 4) | low;
    }
    Ok(digest)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Direct Win32 observation. This module is read-only; the separate target
/// adapter remains unreachable until an authenticated operation is supplied.
#[cfg(windows)]
mod native_observation {
    use super::{
        MAX_ANCESTRY_NODES, MAX_VOLUMES, ObservationError, WindowsDiskSnapshot, hex_bytes, sha256,
    };
    use std::{
        ffi::{OsStr, c_void},
        fs::File,
        os::windows::{
            ffi::OsStrExt,
            fs::FileExt,
            io::{AsRawHandle, FromRawHandle, RawHandle},
        },
        ptr,
    };

    const DIGCF_PRESENT: u32 = 2;
    const DIGCF_DEVICEINTERFACE: u32 = 16;
    const ERROR_NO_MORE_ITEMS: u32 = 259;
    const ERROR_NO_MORE_FILES: u32 = 18;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ_WRITE: u32 = 3;
    const IOCTL_DISK_GET_DRIVE_GEOMETRY_EX: u32 = 0x0007_00A0;
    const IOCTL_DISK_IS_WRITABLE: u32 = 0x0007_0090;
    const IOCTL_STORAGE_GET_DEVICE_NUMBER: u32 = 0x002D_1080;
    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
    const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;
    const STORAGE_DEVICE_PROPERTY: u32 = 0;
    const STORAGE_ACCESS_ALIGNMENT_PROPERTY: u32 = 6;
    const REG_MULTI_SZ: u32 = 7;
    const RRF_RT_REG_MULTI_SZ: u32 = 0x0000_0020;
    const CR_SUCCESS: u32 = 0;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    // GUID_DEVINTERFACE_DISK, as specified by the Windows storage interface.
    const DISK_INTERFACE: Guid = Guid {
        data1: 0x53f56307,
        data2: 0xb6bf,
        data3: 0x11d0,
        data4: [0x94, 0xf2, 0x00, 0xa0, 0xc9, 0x1e, 0xfb, 0x8b],
    };
    #[repr(C)]
    struct InterfaceData {
        cb_size: u32,
        interface_class_guid: Guid,
        flags: u32,
        reserved: usize,
    }
    #[repr(C)]
    struct DeviceInfoData {
        cb_size: u32,
        class_guid: Guid,
        dev_inst: u32,
        reserved: usize,
    }
    #[repr(C)]
    struct StoragePropertyQuery {
        property_id: u32,
        query_type: u32,
        additional: [u8; 1],
    }
    #[repr(C)]
    struct VolumeExtent {
        disk_number: u32,
        _pad: u32,
        starting_offset: i64,
        extent_length: i64,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            creation: u32,
            flags: u32,
            template: isize,
        ) -> isize;
        fn DeviceIoControl(
            handle: isize,
            code: u32,
            input: *const c_void,
            input_size: u32,
            output: *mut c_void,
            output_size: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn FindFirstVolumeW(name: *mut u16, length: u32) -> isize;
        fn FindNextVolumeW(find: isize, name: *mut u16, length: u32) -> i32;
        fn FindVolumeClose(find: isize) -> i32;
        fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
        fn GetVolumePathNameW(path: *const u16, volume_path: *mut u16, length: u32) -> i32;
        fn GetVolumeNameForVolumeMountPointW(
            volume_path: *const u16,
            volume_name: *mut u16,
            length: u32,
        ) -> i32;
        fn GetVolumePathNamesForVolumeNameW(
            volume_name: *const u16,
            paths: *mut u16,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
    #[link(name = "setupapi")]
    unsafe extern "system" {
        fn SetupDiGetClassDevsW(
            class: *const Guid,
            enumerator: *const u16,
            parent: isize,
            flags: u32,
        ) -> isize;
        fn SetupDiEnumDeviceInterfaces(
            set: isize,
            device: *const DeviceInfoData,
            class: *const Guid,
            index: u32,
            output: *mut InterfaceData,
        ) -> i32;
        fn SetupDiGetDeviceInterfaceDetailW(
            set: isize,
            interface: *mut InterfaceData,
            detail: *mut c_void,
            detail_size: u32,
            required: *mut u32,
            device: *mut DeviceInfoData,
        ) -> i32;
        fn SetupDiDestroyDeviceInfoList(set: isize) -> i32;
    }
    #[link(name = "cfgmgr32")]
    unsafe extern "system" {
        fn CM_Get_Device_ID_Size(length: *mut u32, dev_inst: u32, flags: u32) -> u32;
        fn CM_Get_Device_IDW(dev_inst: u32, buffer: *mut u16, length: u32, flags: u32) -> u32;
        fn CM_Get_Parent(parent: *mut u32, dev_inst: u32, flags: u32) -> u32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            bytes: *mut u32,
        ) -> i32;
    }

    struct Volume {
        id: String,
        mounts: Vec<String>,
        disks: Vec<u32>,
    }
    struct Disk {
        path: String,
        dev_inst: u32,
        number: u32,
    }

    pub(super) fn collect_snapshot(
        disk_number: u32,
    ) -> Result<WindowsDiskSnapshot, ObservationError> {
        let disks = enumerate_disks()?;
        let disk = disks
            .into_iter()
            .find(|disk| disk.number == disk_number)
            .ok_or(ObservationError::Changed)?;
        let ancestry = device_ancestry(disk.dev_inst)?;
        let disk_file = open_read(&disk.path)?;
        let number = query_device_number(disk_file.as_raw_handle())?;
        if number != disk_number {
            return Err(ObservationError::Changed);
        }
        let (capacity_bytes, sector_bytes) = query_geometry(disk_file.as_raw_handle())?;
        let (usb_transport, removable, serial) = query_storage_identity(disk_file.as_raw_handle())?;
        let volumes = enumerate_volumes()?;
        let system_volumes = system_and_pagefile_volumes()?;
        if system_volumes
            .iter()
            .any(|system| !volumes.iter().any(|volume| &volume.id == system))
        {
            return Err(ObservationError::NativeUnavailable);
        }
        let associated = volumes
            .into_iter()
            .filter(|volume| volume.disks.contains(&disk_number))
            .collect::<Vec<_>>();
        if associated.len() > MAX_VOLUMES {
            return Err(ObservationError::InvalidInput);
        }
        if associated
            .iter()
            .any(|volume| volume.disks.iter().any(|other| *other != disk_number))
        {
            // Spanned/mirrored volume ancestry is ambiguous for a whole-disk image.
            return Err(ObservationError::Ineligible);
        }
        let volume_ids = associated
            .iter()
            .map(|volume| volume.id.clone())
            .collect::<Vec<_>>();
        let system_backing = associated
            .iter()
            .any(|volume| system_volumes.contains(&volume.id));
        let mount_material = associated
            .iter()
            .flat_map(|volume| {
                std::iter::once(volume.id.as_str()).chain(volume.mounts.iter().map(String::as_str))
            })
            .collect::<Vec<_>>()
            .join("\0");
        let mount_fingerprint = hex_bytes(&sha256(mount_material.as_bytes()));
        let (table_fingerprint, _) = table_fingerprint(&disk_file, capacity_bytes)?;
        let usb_ancestry = ancestry
            .iter()
            .any(|node| node.starts_with("USB\\") || node.starts_with("USBSTOR\\"));
        let ancestry_complete = !ancestry.is_empty() && ancestry.len() <= MAX_ANCESTRY_NODES;
        let snapshot = WindowsDiskSnapshot {
            disk_number,
            capacity_bytes,
            sector_bytes,
            usb_transport: usb_transport && usb_ancestry,
            removable,
            internal: !usb_transport || !usb_ancestry,
            system_backing,
            ancestry_complete,
            writable: query_writable(disk_file.as_raw_handle()),
            serial,
            // No reliable last-arrival property is documented by Windows.
            // InstallDate is affected by driver updates and is not a
            // connection-generation substitute, so this collector refuses
            // before returning an eligible observation.
            connection_generation: None,
            pnp_ancestry: ancestry,
            volume_ids,
            table_fingerprint,
            mount_fingerprint,
        };
        // Do not claim that serial, model, USB port path, or InstallDate prove
        // one physical attachment. The packaged client must supply a
        // generation observed across the approval/UAC boundary.
        super::validate_snapshot(&snapshot).map_err(|error| {
            if snapshot.connection_generation.is_none() {
                ObservationError::NativeUnavailable
            } else {
                error
            }
        })?;
        Ok(snapshot)
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }
    fn utf16_z(buffer: &[u16]) -> Result<String, ObservationError> {
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .ok_or(ObservationError::InvalidInput)?;
        String::from_utf16(&buffer[..end]).map_err(|_| ObservationError::InvalidInput)
    }
    fn open_read(path: &str) -> Result<File, ObservationError> {
        let path = wide(path);
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ_WRITE,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                0,
            )
        };
        if handle == -1 {
            return Err(ObservationError::NativeUnavailable);
        }
        Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
    }
    fn device_interface_path(
        set: isize,
        interface: &mut InterfaceData,
        device: &mut DeviceInfoData,
    ) -> Result<String, ObservationError> {
        let mut required = 0;
        let first = unsafe {
            SetupDiGetDeviceInterfaceDetailW(
                set,
                interface,
                ptr::null_mut(),
                0,
                &mut required,
                device,
            )
        };
        if first != 0 || !(8..=64 * 1024).contains(&required) {
            return Err(ObservationError::NativeUnavailable);
        }
        let mut aligned = vec![0_u64; (required as usize).div_ceil(8)];
        let buffer = aligned.as_mut_ptr().cast::<u8>();
        unsafe {
            *(buffer.cast::<u32>()) = 8;
        }
        let success = unsafe {
            SetupDiGetDeviceInterfaceDetailW(
                set,
                interface,
                buffer.cast(),
                required,
                &mut required,
                device,
            )
        };
        if success == 0 {
            return Err(ObservationError::NativeUnavailable);
        }
        let units = unsafe {
            std::slice::from_raw_parts(buffer.add(4).cast::<u16>(), (required as usize - 4) / 2)
        };
        utf16_z(units)
    }
    fn enumerate_disks() -> Result<Vec<Disk>, ObservationError> {
        let set = unsafe {
            SetupDiGetClassDevsW(
                &DISK_INTERFACE,
                ptr::null(),
                0,
                DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
            )
        };
        if set == -1 {
            return Err(ObservationError::NativeUnavailable);
        }
        let result = (|| {
            let mut disks = Vec::new();
            for index in 0..4096_u32 {
                let mut interface = InterfaceData {
                    cb_size: std::mem::size_of::<InterfaceData>() as u32,
                    interface_class_guid: DISK_INTERFACE,
                    flags: 0,
                    reserved: 0,
                };
                let mut device = DeviceInfoData {
                    cb_size: std::mem::size_of::<DeviceInfoData>() as u32,
                    class_guid: Guid {
                        data1: 0,
                        data2: 0,
                        data3: 0,
                        data4: [0; 8],
                    },
                    dev_inst: 0,
                    reserved: 0,
                };
                if unsafe {
                    SetupDiEnumDeviceInterfaces(
                        set,
                        ptr::null(),
                        &DISK_INTERFACE,
                        index,
                        &mut interface,
                    )
                } == 0
                {
                    let error = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
                    if error == ERROR_NO_MORE_ITEMS {
                        break;
                    }
                    return Err(ObservationError::NativeUnavailable);
                }
                let path = device_interface_path(set, &mut interface, &mut device)?;
                let file = open_read(&path)?;
                let number = query_device_number(file.as_raw_handle())?;
                if disks.iter().any(|disk: &Disk| disk.number == number) {
                    return Err(ObservationError::Ineligible);
                }
                disks.push(Disk {
                    path,
                    dev_inst: device.dev_inst,
                    number,
                });
            }
            if disks.is_empty() {
                return Err(ObservationError::NativeUnavailable);
            }
            Ok(disks)
        })();
        unsafe {
            SetupDiDestroyDeviceInfoList(set);
        }
        result
    }
    fn device_ancestry(mut dev_inst: u32) -> Result<Vec<String>, ObservationError> {
        let mut result = Vec::new();
        for _ in 0..MAX_ANCESTRY_NODES {
            let mut length = 0;
            if unsafe { CM_Get_Device_ID_Size(&mut length, dev_inst, 0) } != CR_SUCCESS
                || length == 0
                || length > 1024
            {
                return Err(ObservationError::NativeUnavailable);
            }
            let mut id = vec![0_u16; length as usize + 1];
            if unsafe { CM_Get_Device_IDW(dev_inst, id.as_mut_ptr(), id.len() as u32, 0) }
                != CR_SUCCESS
            {
                return Err(ObservationError::NativeUnavailable);
            }
            let value = utf16_z(&id)?;
            if result.contains(&value) {
                return Err(ObservationError::Ineligible);
            }
            result.push(value);
            let mut parent = 0;
            let status = unsafe { CM_Get_Parent(&mut parent, dev_inst, 0) };
            if status == 13 {
                return Ok(result);
            } // CR_NO_SUCH_DEVNODE: reached the PnP root.
            if status != CR_SUCCESS {
                return Err(ObservationError::NativeUnavailable);
            }
            dev_inst = parent;
        }
        Err(ObservationError::Ineligible)
    }
    fn query_device_number(handle: RawHandle) -> Result<u32, ObservationError> {
        let mut output = [0_u32; 3];
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_STORAGE_GET_DEVICE_NUMBER,
                ptr::null(),
                0,
                output.as_mut_ptr().cast(),
                12,
                &mut returned,
                ptr::null_mut(),
            )
        } == 0
            || !(8..=12).contains(&returned)
        {
            return Err(ObservationError::NativeUnavailable);
        }
        Ok(output[1])
    }
    fn query_geometry(handle: RawHandle) -> Result<(u64, u32), ObservationError> {
        let mut geometry = [0_u8; 40];
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
                ptr::null(),
                0,
                geometry.as_mut_ptr().cast(),
                geometry.len() as u32,
                &mut returned,
                ptr::null_mut(),
            )
        } == 0
            || returned < 32
            || returned > geometry.len() as u32
        {
            return Err(ObservationError::NativeUnavailable);
        }
        let capacity = i64::from_ne_bytes(geometry[24..32].try_into().unwrap());
        if capacity <= 0 {
            return Err(ObservationError::Ineligible);
        }
        let query = StoragePropertyQuery {
            property_id: STORAGE_ACCESS_ALIGNMENT_PROPERTY,
            query_type: 0,
            additional: [0],
        };
        let mut alignment = [0_u32; 7];
        if unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_STORAGE_QUERY_PROPERTY,
                (&query as *const StoragePropertyQuery).cast(),
                12,
                alignment.as_mut_ptr().cast(),
                28,
                &mut returned,
                ptr::null_mut(),
            )
        } == 0
            || !(20..=28).contains(&returned)
        {
            return Err(ObservationError::NativeUnavailable);
        }
        Ok((capacity as u64, alignment[4]))
    }
    fn query_storage_identity(
        handle: RawHandle,
    ) -> Result<(bool, bool, Option<String>), ObservationError> {
        let query = StoragePropertyQuery {
            property_id: STORAGE_DEVICE_PROPERTY,
            query_type: 0,
            additional: [0],
        };
        let mut bytes = vec![0_u64; 2048];
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_STORAGE_QUERY_PROPERTY,
                (&query as *const StoragePropertyQuery).cast(),
                12,
                bytes.as_mut_ptr().cast(),
                (bytes.len() * 8) as u32,
                &mut returned,
                ptr::null_mut(),
            )
        } == 0
            || returned < 36
            || returned as usize > bytes.len() * 8
        {
            return Err(ObservationError::NativeUnavailable);
        }
        let raw =
            unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), returned as usize) };
        let bus = u32::from_ne_bytes(raw[28..32].try_into().unwrap());
        let removable = raw[10] != 0;
        let serial_offset = u32::from_ne_bytes(raw[24..28].try_into().unwrap()) as usize;
        let serial = if serial_offset == 0 {
            None
        } else {
            if serial_offset >= raw.len() {
                return Err(ObservationError::InvalidInput);
            }
            let end = raw[serial_offset..]
                .iter()
                .position(|value| *value == 0)
                .ok_or(ObservationError::InvalidInput)?
                + serial_offset;
            let value = String::from_utf8_lossy(&raw[serial_offset..end])
                .trim()
                .to_string();
            if value.is_empty() { None } else { Some(value) }
        };
        Ok((bus == 7, removable, serial))
    }
    fn query_writable(handle: RawHandle) -> bool {
        let mut returned = 0;
        unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_DISK_IS_WRITABLE,
                ptr::null(),
                0,
                ptr::null_mut(),
                0,
                &mut returned,
                ptr::null_mut(),
            ) != 0
        }
    }
    fn query_extents(volume: &str) -> Result<Vec<u32>, ObservationError> {
        let handle = open_read(volume)?;
        let mut bytes = vec![0_u64; 1024];
        let mut returned = 0;
        let success = unsafe {
            DeviceIoControl(
                handle.as_raw_handle() as isize,
                IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                ptr::null(),
                0,
                bytes.as_mut_ptr().cast(),
                (bytes.len() * 8) as u32,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if success == 0
            || returned < 8 + std::mem::size_of::<VolumeExtent>() as u32
            || returned as usize > bytes.len() * 8
        {
            return Err(ObservationError::NativeUnavailable);
        }
        let count = unsafe { *(bytes.as_ptr().cast::<u32>()) } as usize;
        let available = (returned as usize - 8) / std::mem::size_of::<VolumeExtent>();
        if count == 0 || count > 64 || count > available {
            return Err(ObservationError::Ineligible);
        }
        let mut disks = Vec::new();
        for index in 0..count {
            let extent = unsafe {
                &*bytes
                    .as_ptr()
                    .cast::<u8>()
                    .add(8 + index * std::mem::size_of::<VolumeExtent>())
                    .cast::<VolumeExtent>()
            };
            if extent.starting_offset < 0 || extent.extent_length <= 0 {
                return Err(ObservationError::Ineligible);
            }
            if !disks.contains(&extent.disk_number) {
                disks.push(extent.disk_number);
            }
        }
        Ok(disks)
    }
    fn enumerate_volumes() -> Result<Vec<Volume>, ObservationError> {
        let mut name = vec![0_u16; 128];
        let find = unsafe { FindFirstVolumeW(name.as_mut_ptr(), name.len() as u32) };
        if find == -1 {
            return Err(ObservationError::NativeUnavailable);
        }
        let result = (|| {
            let mut volumes = Vec::new();
            loop {
                let id = utf16_z(&name)?;
                if !super::valid_volume_id(&id) {
                    return Err(ObservationError::InvalidInput);
                }
                let disks = query_extents(&id)?;
                let mut needed = 0;
                let _ = unsafe {
                    GetVolumePathNamesForVolumeNameW(name.as_ptr(), ptr::null_mut(), 0, &mut needed)
                };
                if needed > 64 * 1024 {
                    return Err(ObservationError::InvalidInput);
                }
                let mut paths = vec![0_u16; needed.max(2) as usize];
                if unsafe {
                    GetVolumePathNamesForVolumeNameW(
                        name.as_ptr(),
                        paths.as_mut_ptr(),
                        paths.len() as u32,
                        &mut needed,
                    )
                } == 0
                {
                    return Err(ObservationError::NativeUnavailable);
                }
                let mounts = paths
                    .split(|unit| *unit == 0)
                    .filter(|part| !part.is_empty())
                    .map(|part| {
                        String::from_utf16(part).map_err(|_| ObservationError::InvalidInput)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                volumes.push(Volume { id, mounts, disks });
                if volumes.len() > MAX_VOLUMES {
                    return Err(ObservationError::InvalidInput);
                }
                if unsafe { FindNextVolumeW(find, name.as_mut_ptr(), name.len() as u32) } == 0 {
                    let error = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
                    if error == ERROR_NO_MORE_FILES {
                        break;
                    }
                    return Err(ObservationError::NativeUnavailable);
                }
            }
            Ok(volumes)
        })();
        unsafe {
            FindVolumeClose(find);
        }
        result
    }
    fn volume_for_path(path: &str) -> Result<String, ObservationError> {
        let path = wide(path);
        let mut root = vec![0_u16; 32768];
        if unsafe { GetVolumePathNameW(path.as_ptr(), root.as_mut_ptr(), root.len() as u32) } == 0 {
            return Err(ObservationError::NativeUnavailable);
        }
        let mut volume = vec![0_u16; 128];
        if unsafe {
            GetVolumeNameForVolumeMountPointW(
                root.as_ptr(),
                volume.as_mut_ptr(),
                volume.len() as u32,
            )
        } == 0
        {
            return Err(ObservationError::NativeUnavailable);
        }
        utf16_z(&volume)
    }
    fn system_and_pagefile_volumes() -> Result<Vec<String>, ObservationError> {
        let mut windows = vec![0_u16; 32768];
        let length = unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) };
        if length == 0 || length as usize >= windows.len() {
            return Err(ObservationError::NativeUnavailable);
        }
        windows[length as usize] = 0;
        let windows = utf16_z(&windows)?;
        let mut result = vec![volume_for_path(&windows)?];
        // PagingFiles is a REG_MULTI_SZ maintained by the Windows memory
        // manager configuration. Treat every configured location as backing
        // storage, even if currently overprovisioned or temporarily inactive.
        const HKLM: isize = (0x8000_0002_u32 as i32) as isize;
        let key = wide(r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management");
        let value = wide("PagingFiles");
        let mut kind = 0;
        let mut bytes = 0;
        let first = unsafe {
            RegGetValueW(
                HKLM,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_MULTI_SZ,
                &mut kind,
                ptr::null_mut(),
                &mut bytes,
            )
        };
        if (first != 0 && first != 234)
            || kind != REG_MULTI_SZ
            || bytes > 1024 * 1024
            || bytes % 2 != 0
        {
            return Err(ObservationError::NativeUnavailable);
        }
        if bytes != 0 {
            let mut data = vec![0_u16; bytes as usize / 2];
            if unsafe {
                RegGetValueW(
                    HKLM,
                    key.as_ptr(),
                    value.as_ptr(),
                    RRF_RT_REG_MULTI_SZ,
                    &mut kind,
                    data.as_mut_ptr().cast(),
                    &mut bytes,
                )
            } != 0
            {
                return Err(ObservationError::NativeUnavailable);
            }
            for item in data
                .split(|unit| *unit == 0)
                .filter(|item| !item.is_empty())
            {
                let setting =
                    String::from_utf16(item).map_err(|_| ObservationError::InvalidInput)?;
                let path = setting
                    .split_whitespace()
                    .next()
                    .ok_or(ObservationError::InvalidInput)?;
                if path.starts_with(r"\??\Volume{") {
                    let volume = path.trim_start_matches(r"\??\");
                    let end = volume.find('}').ok_or(ObservationError::InvalidInput)? + 1;
                    let id = format!(r"{}\", &volume[..end]);
                    if !super::valid_volume_id(&id) {
                        return Err(ObservationError::InvalidInput);
                    }
                    result.push(id);
                } else {
                    let path = path.trim_start_matches(r"\??\");
                    let path_bytes = path.as_bytes();
                    if path_bytes.len() < 3
                        || !path_bytes[0].is_ascii_alphabetic()
                        || path_bytes[1] != b':'
                        || path_bytes[2] != b'\\'
                    {
                        return Err(ObservationError::NativeUnavailable);
                    }
                    result.push(volume_for_path(path)?);
                }
            }
        }
        result.sort();
        result.dedup();
        Ok(result)
    }
    fn table_fingerprint(
        file: &File,
        capacity: u64,
    ) -> Result<(String, [u8; 32]), ObservationError> {
        let width = 34 * 512;
        let tail_offset = capacity
            .checked_sub(width as u64)
            .ok_or(ObservationError::Ineligible)?;
        let mut head = vec![0; width];
        let mut tail = vec![0; width];
        read_exact_at(file, &mut head, 0)?;
        read_exact_at(file, &mut tail, tail_offset)?;
        let fingerprint = ais_host_core::device::table_fingerprint(&head, &tail)
            .map_err(|_| ObservationError::InvalidInput)?;
        let mut material = head;
        material.extend_from_slice(&tail);
        Ok((hex_bytes(&fingerprint), sha256(&material)))
    }
    fn read_exact_at(file: &File, output: &mut [u8], offset: u64) -> Result<(), ObservationError> {
        let mut read = 0;
        while read < output.len() {
            let count = file
                .seek_read(&mut output[read..], offset + read as u64)
                .map_err(|_| ObservationError::NativeUnavailable)?;
            if count == 0 {
                return Err(ObservationError::NativeUnavailable);
            }
            read += count;
        }
        Ok(())
    }
}

#[cfg(windows)]
mod native {
    use super::{
        ObservationError, WindowsDiskSnapshot, collect_windows_snapshot, observe_windows_snapshot,
        recheck_windows_snapshot,
    };
    use crate::protocol::AuthenticatedChannel;
    use ais_host_core::device::{DeviceObservation, WriteTarget};
    use std::{
        ffi::{OsStr, c_void},
        fs::File,
        io::{self, Read, Seek, SeekFrom, Write},
        os::windows::{
            ffi::OsStrExt,
            fs::FileExt,
            io::{AsRawHandle, FromRawHandle, RawHandle},
        },
        ptr,
    };

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const FSCTL_LOCK_VOLUME: u32 = 0x0009_0018;
    const FSCTL_DISMOUNT_VOLUME: u32 = 0x0009_0020;
    const IOCTL_DISK_GET_DRIVE_GEOMETRY_EX: u32 = 0x0007_00A0;
    const IOCTL_DISK_IS_WRITABLE: u32 = 0x0007_0090;
    const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            creation: u32,
            flags: u32,
            template: isize,
        ) -> isize;
        fn DeviceIoControl(
            handle: isize,
            control: u32,
            in_buffer: *const c_void,
            in_size: u32,
            out_buffer: *mut c_void,
            out_size: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn FlushFileBuffers(handle: isize) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    pub struct WindowsBlockTarget {
        disk: File,
        volumes: Vec<File>,
        approved: DeviceObservation,
        snapshot: WindowsDiskSnapshot,
    }

    impl WindowsBlockTarget {
        pub(crate) fn open_authenticated(
            _channel: &AuthenticatedChannel,
            approved: &DeviceObservation,
        ) -> Result<Self, ObservationError> {
            approved
                .validate()
                .map_err(|_| ObservationError::Ineligible)?;
            let disk_number = approved
                .os_identity
                .strip_prefix("windows:PhysicalDrive")
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or(ObservationError::Ineligible)?;
            let snapshot = collect_windows_snapshot(disk_number)?;
            let observed = observe_windows_snapshot(&snapshot)?;
            if observed.observation != *approved {
                return Err(ObservationError::Changed);
            }
            let path = format!(r"\\.\PhysicalDrive{disk_number}");
            // Windows locks volumes before dismounting them. The raw disk
            // handle permits existing volume handles while those locks are
            // acquired; the exclusive volume locks provide the exclusion.
            let disk = open_with_share(&path, GENERIC_READ | GENERIC_WRITE, 0x3)?;
            verify_geometry(disk.as_raw_handle(), &snapshot)?;
            let mut volumes = Vec::with_capacity(snapshot.volume_ids.len());
            for volume in &snapshot.volume_ids {
                // The volume control codes require a direct-access handle and
                // the documented read/write sharing mode.
                let handle = open_with_share(volume, GENERIC_READ | GENERIC_WRITE, 0x3)?;
                let raw = handle.as_raw_handle() as isize;
                verify_volume_extents(raw, disk_number)?;
                ioctl(raw, FSCTL_LOCK_VOLUME)?;
                ioctl(raw, FSCTL_DISMOUNT_VOLUME)?;
                volumes.push(handle);
            }
            Ok(Self {
                disk,
                volumes,
                approved: approved.clone(),
                snapshot,
            })
        }

        /// Positional reads preserve the writer's cursor. Used for table
        /// fingerprints while the shared writer uses sequential writes.
        fn read_range(&self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
            let mut bytes = vec![0; length];
            let mut read = 0;
            while read < bytes.len() {
                let count = self
                    .disk
                    .seek_read(&mut bytes[read..], offset + read as u64)?;
                if count == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "short disk read",
                    ));
                }
                read += count;
            }
            Ok(bytes)
        }
    }

    impl Read for WindowsBlockTarget {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.disk.read(buf)
        }
    }
    impl Write for WindowsBlockTarget {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.disk.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.disk.flush()
        }
    }
    impl Seek for WindowsBlockTarget {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.disk.seek(pos)
        }
    }

    impl WriteTarget for WindowsBlockTarget {
        fn observe(&self) -> io::Result<DeviceObservation> {
            let current = collect_windows_snapshot(self.snapshot.disk_number)
                .map_err(|_| io::Error::other("native device recheck failed"))?;
            recheck_windows_snapshot(&self.snapshot, &current)
                .map_err(|_| io::Error::other("native device identity changed"))?;
            let head = self.read_range(0, 34 * 512)?;
            let tail_offset = current
                .capacity_bytes
                .checked_sub((34 * 512) as u64)
                .ok_or_else(|| io::Error::other("invalid disk capacity"))?;
            let tail = self.read_range(tail_offset, 34 * 512)?;
            let table = ais_host_core::device::table_fingerprint(&head, &tail)
                .map_err(|_| io::Error::other("invalid table fingerprint bounds"))?;
            let mut observed = observe_windows_snapshot(&current)
                .map_err(|_| io::Error::other("native observation failed"))?
                .observation;
            observed.table_fingerprint = table;
            if observed.os_identity != self.approved.os_identity
                || observed.connection_identity != self.approved.connection_identity
                || observed.capacity_bytes != self.approved.capacity_bytes
                || observed.ancestry_fingerprint != self.approved.ancestry_fingerprint
                || observed.mount_fingerprint != self.approved.mount_fingerprint
            {
                return Err(io::Error::other("native device identity changed"));
            }
            Ok(observed)
        }

        fn lock_exclusive(&mut self) -> io::Result<()> {
            // Volume handles were separately locked and dismounted before
            // this target exists. Their lifetime holds the exclusive locks.
            if self
                .volumes
                .iter()
                .any(|volume| volume.as_raw_handle().is_null())
            {
                return Err(io::Error::other("volume lock handle invalid"));
            }
            Ok(())
        }

        fn flush_durable(&mut self) -> io::Result<()> {
            if unsafe { FlushFileBuffers(self.disk.as_raw_handle() as isize) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    fn open_with_share(path: &str, access: u32, share: u32) -> Result<File, ObservationError> {
        let mut wide = OsStr::new(path).encode_wide().collect::<Vec<_>>();
        wide.push(0);
        // SAFETY: the path is generated from a validated disk number or a
        // validated volume GUID, and the API copies the terminated path.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                share,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                0,
            )
        };
        if handle == -1 {
            return Err(ObservationError::NativeUnavailable);
        }
        // SAFETY: CreateFileW returned an owned valid handle.
        Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
    }

    fn ioctl(handle: isize, code: u32) -> Result<(), ObservationError> {
        let mut returned = 0;
        // SAFETY: these control codes take no input and return no output.
        let success = unsafe {
            DeviceIoControl(
                handle,
                code,
                ptr::null(),
                0,
                ptr::null_mut(),
                0,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if success == 0 {
            Err(ObservationError::NativeUnavailable)
        } else {
            Ok(())
        }
    }

    fn verify_volume_extents(handle: isize, expected_disk: u32) -> Result<(), ObservationError> {
        #[repr(C)]
        struct DiskExtent {
            disk_number: u32,
            _padding: u32,
            starting_offset: i64,
            extent_length: i64,
        }
        let mut bytes = vec![0_u64; 1024];
        let mut returned = 0;
        // SAFETY: the output buffer is aligned and bounded. Truncated or
        // malformed driver responses are rejected before the volume is locked.
        let success = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                ptr::null(),
                0,
                bytes.as_mut_ptr().cast(),
                (bytes.len() * 8) as u32,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if success == 0 || returned < 8 + std::mem::size_of::<DiskExtent>() as u32 {
            return Err(ObservationError::NativeUnavailable);
        }
        let count = unsafe { *(bytes.as_ptr().cast::<u32>()) } as usize;
        let offset = 8;
        let extent_size = std::mem::size_of::<DiskExtent>();
        let available = (returned as usize).saturating_sub(offset) / extent_size;
        if count == 0 || count > 64 || count > available {
            return Err(ObservationError::Ineligible);
        }
        for index in 0..count {
            let extent = unsafe {
                &*bytes
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset + index * extent_size)
                    .cast::<DiskExtent>()
            };
            if extent.disk_number != expected_disk
                || extent.starting_offset < 0
                || extent.extent_length <= 0
            {
                return Err(ObservationError::Ineligible);
            }
        }
        Ok(())
    }

    fn verify_geometry(
        handle: RawHandle,
        snapshot: &WindowsDiskSnapshot,
    ) -> Result<(), ObservationError> {
        #[repr(C)]
        struct GeometryEx {
            geometry: [u8; 24],
            disk_size: i64,
            data: [u8; 1],
        }
        let mut value = GeometryEx {
            geometry: [0; 24],
            disk_size: 0,
            data: [0],
        };
        let mut returned = 0;
        // SAFETY: the buffer has room for the fixed geometry header and size.
        let success = unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
                ptr::null(),
                0,
                (&mut value as *mut GeometryEx).cast(),
                std::mem::size_of::<GeometryEx>() as u32,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if success == 0 || value.disk_size < 0 || value.disk_size as u64 != snapshot.capacity_bytes
        {
            return Err(ObservationError::Changed);
        }
        let mut ignored = 0;
        // A failure means read-only/unknown state, so it is not a valid target.
        let writable = unsafe {
            DeviceIoControl(
                handle as isize,
                IOCTL_DISK_IS_WRITABLE,
                ptr::null(),
                0,
                ptr::null_mut(),
                0,
                &mut ignored,
                ptr::null_mut(),
            )
        };
        if writable == 0 {
            return Err(ObservationError::Ineligible);
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use native::WindowsBlockTarget;
