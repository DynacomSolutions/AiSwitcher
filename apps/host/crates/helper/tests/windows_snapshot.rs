#![cfg(feature = "file-test")]

use ais_host_helper::platform::{
    WindowsObservationError, observe_windows_snapshot, parse_windows_snapshot,
    recheck_windows_snapshot,
};

const FIXTURE: &str = r#"{
  "diskNumber": 7,
  "capacityBytes": 16777216,
  "sectorBytes": 512,
  "usbTransport": true,
  "removable": true,
  "internal": false,
  "systemBacking": false,
  "ancestryComplete": true,
  "writable": true,
  "serial": "SYNTHETIC_FIXTURE_DISK_SERIAL",
  "connectionGeneration": "SYNTHETIC_FIXTURE_ARRIVAL_1",
  "pnpAncestry": ["SYNTHETIC_FIXTURE_USBROOT", "SYNTHETIC_FIXTURE_DISK"],
  "volumeIds": [],
  "tableFingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "mountFingerprint": "1111111111111111111111111111111111111111111111111111111111111111"
}"#;

#[test]
fn accepts_complete_external_usb_snapshot_and_derives_stable_identity() {
    let snapshot = parse_windows_snapshot(FIXTURE).expect("synthetic snapshot is valid");
    let observed = observe_windows_snapshot(&snapshot).expect("eligible USB observation");
    assert_eq!(observed.observation.os_identity, "windows:PhysicalDrive7");
    assert_eq!(observed.observation.display_identifier, "PhysicalDrive7");
    assert!(observed.observation.external_usb);
    assert!(observed.observation.ancestry_complete);
}

#[test]
fn refuses_internal_system_and_ambiguous_devices() {
    for (needle, replacement) in [
        ("\"internal\": false", "\"internal\": true"),
        ("\"systemBacking\": false", "\"systemBacking\": true"),
        ("\"ancestryComplete\": true", "\"ancestryComplete\": false"),
        ("\"usbTransport\": true", "\"usbTransport\": false"),
    ] {
        let changed = FIXTURE.replace(needle, replacement);
        let result = parse_windows_snapshot(&changed);
        assert!(
            matches!(result, Err(WindowsObservationError::Ineligible)),
            "{needle}"
        );
    }
}

#[test]
fn rejects_unknown_fields_bad_digests_duplicate_ancestry_and_bad_volumes() {
    assert_eq!(
        parse_windows_snapshot(
            &FIXTURE.replace("\n}", ",\n  \"devicePath\": \"\\\\.\\PhysicalDrive7\"\n}")
        ),
        Err(WindowsObservationError::InvalidInput)
    );
    assert_eq!(
        parse_windows_snapshot(&FIXTURE.replace(&"0".repeat(64), &"z".repeat(64))),
        Err(WindowsObservationError::InvalidInput)
    );
    assert_eq!(
        parse_windows_snapshot(&FIXTURE.replace(
            "\"SYNTHETIC_FIXTURE_USBROOT\", \"SYNTHETIC_FIXTURE_DISK\"",
            "\"SYNTHETIC_FIXTURE_USBROOT\", \"SYNTHETIC_FIXTURE_USBROOT\""
        )),
        Err(WindowsObservationError::InvalidInput)
    );
    let with_bad_volume = FIXTURE.replace(
        "\"volumeIds\": []",
        "\"volumeIds\": [\"SYNTHETIC_FIXTURE_VOLUME\"]",
    );
    assert_eq!(
        parse_windows_snapshot(&with_bad_volume),
        Err(WindowsObservationError::InvalidInput)
    );
}

#[test]
fn recheck_detects_mount_identity_and_ancestry_changes_but_leaves_table_phases_to_core() {
    let approved = parse_windows_snapshot(FIXTURE).expect("valid fixture");
    let planned_table_change =
        parse_windows_snapshot(&FIXTURE.replace(&"0".repeat(64), &"2".repeat(64)))
            .expect("table digest remains well formed");
    assert_eq!(
        recheck_windows_snapshot(&approved, &planned_table_change),
        Ok(())
    );

    for changed in [
        FIXTURE.replace(&"1".repeat(64), &"3".repeat(64)),
        FIXTURE.replace(
            "SYNTHETIC_FIXTURE_DISK_SERIAL",
            "SYNTHETIC_FIXTURE_OTHER_SERIAL",
        ),
        FIXTURE.replace(
            "SYNTHETIC_FIXTURE_USBROOT",
            "SYNTHETIC_FIXTURE_OTHER_PARENT",
        ),
        FIXTURE.replace("SYNTHETIC_FIXTURE_ARRIVAL_1", "SYNTHETIC_FIXTURE_ARRIVAL_2"),
    ] {
        let current = parse_windows_snapshot(&changed).expect("changed fixture remains valid");
        assert_eq!(
            recheck_windows_snapshot(&approved, &current),
            Err(WindowsObservationError::Changed)
        );
    }
}

#[test]
fn same_disk_path_model_and_serial_with_new_arrival_generation_is_a_new_connection() {
    let first = parse_windows_snapshot(FIXTURE).expect("valid first synthetic arrival");
    let second = parse_windows_snapshot(
        &FIXTURE.replace("SYNTHETIC_FIXTURE_ARRIVAL_1", "SYNTHETIC_FIXTURE_ARRIVAL_2"),
    )
    .expect("valid second synthetic arrival");

    let first_observation = observe_windows_snapshot(&first).expect("first observation");
    let second_observation = observe_windows_snapshot(&second).expect("second observation");
    assert_eq!(first.disk_number, second.disk_number);
    assert_eq!(first.serial, second.serial);
    assert_eq!(first.pnp_ancestry, second.pnp_ancestry);
    assert_ne!(
        first_observation.observation.connection_identity,
        second_observation.observation.connection_identity
    );
    assert_eq!(
        recheck_windows_snapshot(&first, &second),
        Err(WindowsObservationError::Changed)
    );
}

#[test]
fn missing_or_malformed_connection_generation_fails_closed() {
    assert_eq!(
        parse_windows_snapshot(&FIXTURE.replace(
            r#"  "connectionGeneration": "SYNTHETIC_FIXTURE_ARRIVAL_1",
"#,
            ""
        )),
        Err(WindowsObservationError::InvalidInput)
    );
    assert_eq!(
        parse_windows_snapshot(&FIXTURE.replace(
            "SYNTHETIC_FIXTURE_ARRIVAL_1",
            "SYNTHETIC_FIXTURE_ARRIVAL_1\n"
        )),
        Err(WindowsObservationError::InvalidInput)
    );
}

#[test]
fn rejects_oversized_input_and_non_sector_aligned_capacity() {
    assert_eq!(
        parse_windows_snapshot(&" ".repeat(1024 * 1024 + 1)),
        Err(WindowsObservationError::InvalidInput)
    );
    let malformed = FIXTURE.replace("16777216", "16777217");
    assert_eq!(
        parse_windows_snapshot(&malformed),
        Err(WindowsObservationError::InvalidInput)
    );

    let unsupported_sector_size = FIXTURE.replace("\"sectorBytes\": 512", "\"sectorBytes\": 4096");
    assert_eq!(
        parse_windows_snapshot(&unsupported_sector_size),
        Err(WindowsObservationError::InvalidInput)
    );
}
