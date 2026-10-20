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

#[test]
fn parses_only_bounded_structured_operations() {
    assert_eq!(
        decode_frame(&frame(request())).unwrap().operation,
        Operation::CreateLayout
    );
    for operation in ["replaceBase", "resetPersist"] {
        let mut value = request();
        value["operation"] = operation.into();
        assert!(decode_frame(&frame(value)).is_ok());
    }
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
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_ais-host-helper"))
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
