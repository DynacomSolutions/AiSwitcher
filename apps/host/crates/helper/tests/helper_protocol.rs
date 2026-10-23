use ais_host_helper::protocol::{
    MAX_REQUEST_BYTES, Operation, decode_frame, require_native_channel,
};

fn frame(value: serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value).unwrap();
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend(body);
    bytes
}
fn request() -> serde_json::Value {
    serde_json::json!({ "version": 1, "operation": "createLayout", "planDigest": "0".repeat(64),
        "channelBinding": "1".repeat(64), "ticket": "2".repeat(64),
        "driveIdentity": ais_host_core::drive_identity::DriveIdentity::fresh().unwrap(),
        "release": { "id": 1, "tag": "live-v1", "publishedAt": 1, "draft": false, "prerelease": false,
            "assets": [
                { "id": 1, "name": "SYNTHETIC_FIXTURE_IMAGE", "size": 1, "revision": "SYNTHETIC_FIXTURE_REVISION" },
                { "id": 2, "name": "SYNTHETIC_FIXTURE_SUMS", "size": 1, "revision": "SYNTHETIC_FIXTURE_REVISION" },
                { "id": 3, "name": "SYNTHETIC_FIXTURE_SIGNATURE", "size": 1, "revision": "SYNTHETIC_FIXTURE_REVISION" }
            ] }, "deviceIdentity": "linux:8:0", "typedConfirmation": "SYNTHETIC_FIXTURE_DISK",
        "confirmationDeadlineBootNs": 1 })
}

fn update_request() -> serde_json::Value {
    let mut value = request();
    value["operation"] = "replaceBase".into();
    value["installedImage"] = serde_json::json!({
        "identity": value["driveIdentity"],
        "releaseOrder": [1, 1],
        "tag": "live-v1",
        "imageDigest": vec![0u8; 32],
        "hardwareHint": "a".repeat(64),
    });
    value
}

/// Windows test executables are built on Linux, so the compile-time binary path is
/// meaningless where they run; AIS_TEST_BIN_DIR points at the copied binaries instead.
fn built_binary(name: &str, compiled: &str) -> std::path::PathBuf {
    std::env::var_os("AIS_TEST_BIN_DIR").map_or_else(
        || compiled.into(),
        |dir| std::path::Path::new(&dir).join(format!("{name}{}", std::env::consts::EXE_SUFFIX)),
    )
}

#[test]
fn parses_only_bounded_structured_operations() {
    assert_eq!(
        decode_frame(&frame(request())).unwrap().operation,
        Operation::CreateLayout
    );
    assert_eq!(
        decode_frame(&frame(update_request())).unwrap().operation,
        Operation::ReplaceBase
    );
    let mut reset = update_request();
    reset["operation"] = "resetPersist".into();
    assert_eq!(
        decode_frame(&frame(reset)).unwrap().operation,
        Operation::ResetPersist
    );
    for key in [
        "command",
        "path",
        "offset",
        "length",
        "passphrase",
        "executable",
    ] {
        let mut value = request();
        value[key] = "SYNTHETIC_FIXTURE".into();
        assert!(decode_frame(&frame(value)).is_err());
    }
    for operation in ["shell", "format", "createLayout; command"] {
        let mut value = request();
        value["operation"] = operation.into();
        assert!(decode_frame(&frame(value)).is_err());
    }
}

#[test]
fn updates_require_matching_installed_image_metadata() {
    let mut missing = update_request();
    missing.as_object_mut().unwrap().remove("installedImage");
    assert!(decode_frame(&frame(missing)).is_err());
    let mut mismatched = update_request();
    mismatched["installedImage"]["identity"] =
        serde_json::to_value(ais_host_core::drive_identity::DriveIdentity::fresh().unwrap())
            .unwrap();
    assert!(decode_frame(&frame(mismatched)).is_err());
    let mut unexpected = update_request();
    unexpected["operation"] = "createLayout".into();
    assert!(decode_frame(&frame(unexpected)).is_err());
    // A reset also names the drive's recorded release; without it the helper cannot plan.
    let mut reset = request();
    reset["operation"] = "resetPersist".into();
    assert!(decode_frame(&frame(reset)).is_err());
}

#[test]
fn rejects_invalid_frames_versions_bindings_and_extra_frames() {
    let valid = frame(request());
    for length in 0..valid.len() {
        assert!(decode_frame(&valid[..length]).is_err());
    }
    let mut trailing = valid.clone();
    trailing.push(0);
    assert!(decode_frame(&trailing).is_err());
    assert!(decode_frame(&((MAX_REQUEST_BYTES + 1) as u32).to_be_bytes()).is_err());
    for key in ["version", "planDigest", "ticket", "channelBinding"] {
        let mut value = request();
        value[key] = serde_json::Value::Null;
        assert!(decode_frame(&frame(value)).is_err());
    }
    let mut value = request();
    value["version"] = 2.into();
    assert!(decode_frame(&frame(value)).is_err());
    assert!(require_native_channel().is_err());
}

#[test]
fn helper_invoked_directly_refuses_without_reading_a_target() {
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    let mut child = std::process::Command::new(built_binary(
        "ais-host-helper",
        env!("CARGO_BIN_EXE_ais-host-helper"),
    ))
    .args(["createLayout", "SYNTHETIC_FIXTURE_DISK"])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    let start = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if start.elapsed() >= Duration::from_secs(5) {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("helper refusal exceeded its deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(77));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("fixed native service operation")
    );
    assert!(!ais_host_helper::writer::available());
}
