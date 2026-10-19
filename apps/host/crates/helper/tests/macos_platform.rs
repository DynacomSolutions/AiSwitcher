#![cfg(feature = "file-test")]

use ais_host_helper::platform::{
    MacDiskSnapshot, MacObservationError as ObservationError, observe_macos_snapshot,
    parse_macos_snapshot, recheck_macos_snapshot,
};

fn fixture(internal: bool, system_backing: bool) -> String {
    format!(
        "identifier=disk9876\ndeviceNode=/dev/disk9876\ncapacityBytes=32000000000\nconnectionGeneration=42001\nancestryComplete=true\nsectorBytes=512\ninternal={internal}\nremovable=true\nprotocol=USB\nserial=SYNTHETIC_FIXTURE_SERIAL\ndeviceTreePath=IOUSBHostDevice/SYNTHETIC_FIXTURE\nwritable=true\npartitions=disk9876s1,false,-;disk9876s2,true,/Volumes/SYNTHETIC_FIXTURE\nsystemBacking={system_backing}\ntableFingerprint={}\nancestryFingerprint={}\nmountFingerprint={}\n",
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64)
    )
}

#[test]
fn parses_synthetic_native_snapshot_and_marks_external_usb() {
    let snapshot = parse_macos_snapshot(&fixture(false, false)).unwrap();
    let observed = observe_macos_snapshot(&snapshot).unwrap();
    assert_eq!(observed.identifier, "disk9876");
    assert_eq!(observed.observation.capacity_bytes, 32_000_000_000);
    assert!(observed.observation.external_usb);
    assert!(!observed.observation.internal);
    assert_eq!(snapshot.partitions.len(), 2);
}

#[test]
fn rejects_internal_and_system_backing_devices() {
    let internal = parse_macos_snapshot(&fixture(true, false)).unwrap();
    assert_eq!(
        observe_macos_snapshot(&internal),
        Err(ObservationError::Ineligible)
    );
    let system = parse_macos_snapshot(&fixture(false, true)).unwrap();
    assert_eq!(
        observe_macos_snapshot(&system),
        Err(ObservationError::Ineligible)
    );
}

#[test]
fn rejects_devices_when_root_physical_ancestry_is_unproven() {
    let snapshot = parse_macos_snapshot(
        &fixture(false, false).replace("ancestryComplete=true", "ancestryComplete=false"),
    )
    .unwrap();
    assert_eq!(
        observe_macos_snapshot(&snapshot),
        Err(ObservationError::Ineligible)
    );
}

#[test]
fn rejects_malformed_or_ambiguous_snapshot_fields() {
    let valid = fixture(false, false);
    assert_eq!(
        parse_macos_snapshot(&(valid.clone() + "internal=false\n")),
        Err(ObservationError::InvalidInput)
    );
    assert_eq!(
        parse_macos_snapshot(&valid.replace(
            "partitions=disk9876s1,false,-;disk9876s2,true,/Volumes/SYNTHETIC_FIXTURE",
            "partitions=disk9876s1,true,-"
        )),
        Err(ObservationError::InvalidInput)
    );
    assert_eq!(
        parse_macos_snapshot(
            &valid.replace("deviceNode=/dev/disk9876", "deviceNode=/dev/disk9876s1")
        ),
        Err(ObservationError::InvalidInput)
    );
    assert_eq!(
        parse_macos_snapshot(&valid.replace("identifier=disk9876", "identifier=disk9a87")),
        Err(ObservationError::InvalidInput)
    );
    assert_eq!(
        parse_macos_snapshot(&valid.replace("disk9876s1", "disk9876sfoo")),
        Err(ObservationError::InvalidInput)
    );
    assert_eq!(
        parse_macos_snapshot(&valid.replace(
            "disk9876s1,false,-;disk9876s2,true,/Volumes/SYNTHETIC_FIXTURE",
            "disk9876s1,false,-;disk9876s1,true,/Volumes/SYNTHETIC_FIXTURE"
        )),
        Err(ObservationError::InvalidInput)
    );
}

#[test]
fn invalidates_confirmation_when_any_observed_fingerprint_changes() {
    let first = parse_macos_snapshot(&fixture(false, false)).unwrap();
    let approved = observe_macos_snapshot(&first).unwrap().observation;
    let changed: MacDiskSnapshot =
        parse_macos_snapshot(&fixture(false, false).replace(&"1".repeat(64), &"4".repeat(64)))
            .unwrap();
    assert_eq!(
        recheck_macos_snapshot(&approved, &changed),
        Err(ObservationError::Changed)
    );
}

#[test]
fn rejects_same_port_serial_capacity_after_native_media_generation_changes() {
    let first = parse_macos_snapshot(&fixture(false, false)).unwrap();
    let approved = observe_macos_snapshot(&first).unwrap().observation;
    let changed = parse_macos_snapshot(
        &fixture(false, false).replace("connectionGeneration=42001", "connectionGeneration=42002"),
    )
    .unwrap();
    assert_eq!(
        recheck_macos_snapshot(&approved, &changed),
        Err(ObservationError::Changed)
    );
}
