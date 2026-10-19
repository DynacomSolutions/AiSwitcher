use std::time::Instant;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ConfirmationSession::default())
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("missing main window configuration")?;
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(is_allowed_navigation)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            preview_write,
            confirm_write,
            invalidate_confirmation,
            disk_write_support,
            native_smoke_ready
        ])
        .run(tauri::generate_context!())
        .expect("host app runtime failed");
}

fn is_allowed_navigation(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("https", Some("tauri.localhost"), None) => true,
        ("http", Some("tauri.localhost"), None) => true,
        #[cfg(not(feature = "custom-protocol"))]
        ("http", Some("localhost"), Some(1420)) => true,
        _ => false,
    }
}

#[tauri::command]
fn list_devices(
    state: tauri::State<'_, ConfirmationSession>,
) -> Vec<ais_host_core::device::DeviceSummary> {
    state.invalidate();
    Vec::new()
}

/// The webview supplies only the native device selector. Device observations,
/// verified image bytes and the resulting plan are retained and constructed by
/// the native process. Discovery and the bundled image contract currently fail
/// closed, so this command cannot produce a preview in this build.
#[tauri::command]
fn preview_write(
    device_id: String,
    state: tauri::State<'_, ConfirmationSession>,
) -> Result<WritePreview, String> {
    state.invalidate();
    if device_id.is_empty() || device_id.len() > 256 || device_id.chars().any(char::is_control) {
        return Err("The selected device is unavailable.".to_string());
    }
    Err(
        "Verified image support and native device discovery are unavailable in this build."
            .to_string(),
    )
}

/// A typed confirmation is checked against a preview retained by native state.
/// Renderer-supplied plans, observations, image hashes and byte ranges are never
/// accepted by this command.
#[tauri::command]
fn confirm_write(
    preview_id: String,
    typed_identifier: String,
    state: tauri::State<'_, ConfirmationSession>,
) -> Result<ConfirmationReceipt, String> {
    state.confirm(&preview_id, &typed_identifier, Instant::now())
}

/// Called whenever a device refresh or a changed create choice invalidates the
/// exact preview the user saw.
#[tauri::command]
fn invalidate_confirmation(state: tauri::State<'_, ConfirmationSession>) {
    state.invalidate();
}

#[tauri::command]
fn disk_write_support() -> ais_host_core::device::WriteSupport {
    ais_host_core::device::write_support()
}

#[tauri::command]
fn native_smoke_ready(app: tauri::AppHandle) -> Result<(), String> {
    if !std::env::args().any(|arg| arg == "--native-smoke") {
        return Err("Native smoke mode is not enabled.".to_string());
    }
    println!("AIS_HOST_READY");
    use std::io::Write;
    let _ = std::io::stdout().flush();
    app.exit(0);
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WritePreview {
    preview_id: String,
    operation: ais_host_core::device::WriteOperation,
    display_identifier: String,
    model: Option<String>,
    capacity_bytes: u64,
    partitions: Vec<PartitionReview>,
    partition_details_available: bool,
    ranges: Vec<ais_host_core::device::ByteRange>,
    image_digest: String,
    confirmation_ttl_seconds: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PartitionReview {
    name: String,
    size_bytes: u64,
    kind: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmationReceipt {
    expires_in_seconds: u64,
}

const CONFIRMATION_TTL: std::time::Duration = std::time::Duration::from_secs(90);

fn fresh_preview_id() -> Result<String, String> {
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce).map_err(|_| "Unable to create a preview identifier.")?;
    Ok(ais_host_core::release::hex(&nonce))
}

struct PendingConfirmation {
    preview_id: String,
    plan: ais_host_core::device::WritePlan,
    image: ais_host_core::release::VerifiedImage,
    details: DeviceReviewDetails,
    ticket: Option<ais_host_core::device::ConfirmationTicket>,
}

/// Presentation fields are collected by the native enumerator. They never
/// provide authority to create a plan or target a device.
#[derive(Default)]
struct DeviceReviewDetails {
    model: Option<String>,
    partitions: Vec<PartitionReview>,
    partition_details_available: bool,
}

/// Session-scoped confirmation authority. Only native code can install a
/// preview; the webview can request an exact identifier check and invalidate it.
#[derive(Default)]
struct ConfirmationSession {
    state: std::sync::Mutex<ConfirmationState>,
}

#[derive(Default)]
struct ConfirmationState {
    pending: Option<PendingConfirmation>,
    approvals: ais_host_core::device::ConfirmationBook,
}

impl ConfirmationSession {
    fn invalidate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.pending = None;
            state.approvals.invalidate();
        }
    }

    fn confirm(
        &self,
        preview_id: &str,
        typed_identifier: &str,
        now: Instant,
    ) -> Result<ConfirmationReceipt, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        let ConfirmationState { pending, approvals } = &mut *state;
        if pending
            .as_ref()
            .is_none_or(|pending| pending.preview_id != preview_id)
        {
            pending.take();
            approvals.invalidate();
            return Err("The preview is unavailable or expired.".to_string());
        }
        let pending = pending.as_mut().expect("pending preview checked");
        let ticket = approvals
            .issue(&pending.plan, typed_identifier, now, CONFIRMATION_TTL)
            .map_err(|error| error.to_string())?;
        pending.ticket = Some(ticket);
        Ok(ConfirmationReceipt {
            expires_in_seconds: CONFIRMATION_TTL.as_secs(),
        })
    }

    fn install_native_preview(
        &self,
        image: ais_host_core::release::VerifiedImage,
        device: ais_host_core::device::DeviceObservation,
        details: DeviceReviewDetails,
    ) -> Result<WritePreview, String> {
        let pending = PendingConfirmation::from_native(image, device, details)?;
        let preview = pending.view();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        state.approvals.invalidate();
        state.pending = Some(pending);
        Ok(preview)
    }

    fn consume(
        &self,
        preview_id: &str,
        current: &ais_host_core::device::DeviceObservation,
        now: Instant,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        let ConfirmationState { pending, approvals } = &mut *state;
        if pending
            .as_ref()
            .is_none_or(|pending| pending.preview_id != preview_id)
        {
            pending.take();
            approvals.invalidate();
            return Err("The preview is unavailable or expired.".to_string());
        }
        let pending = pending.as_mut().expect("pending preview checked");
        let ticket = pending
            .ticket
            .take()
            .ok_or("Typed confirmation is required.")?;
        approvals
            .consume(&ticket, &pending.plan, current, &pending.image, now)
            .map_err(|error| error.to_string())
    }
}

impl PendingConfirmation {
    /// This constructor takes only native-owned values and is intentionally
    /// private to the command module. No IPC type can deserialize a plan.
    fn from_native(
        image: ais_host_core::release::VerifiedImage,
        device: ais_host_core::device::DeviceObservation,
        details: DeviceReviewDetails,
    ) -> Result<Self, String> {
        let plan = ais_host_core::device::WritePlan::create_layout(&image, device)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            preview_id: fresh_preview_id()?,
            plan,
            image,
            details,
            ticket: None,
        })
    }

    fn view(&self) -> WritePreview {
        WritePreview {
            preview_id: self.preview_id.clone(),
            operation: self.plan.operation(),
            display_identifier: self.plan.device().display_identifier.clone(),
            model: self.details.model.clone(),
            capacity_bytes: self.plan.device().capacity_bytes,
            partitions: self
                .details
                .partitions
                .iter()
                .map(|partition| PartitionReview {
                    name: partition.name.clone(),
                    size_bytes: partition.size_bytes,
                    kind: partition.kind.clone(),
                })
                .collect(),
            partition_details_available: self.details.partition_details_available,
            ranges: self.plan.ranges().to_vec(),
            image_digest: ais_host_core::release::hex(&self.image.digest()),
            confirmation_ttl_seconds: CONFIRMATION_TTL.as_secs(),
        }
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::is_allowed_navigation;
    use tauri::Url;

    #[test]
    fn accepts_only_app_origins() {
        for value in [
            "tauri://localhost/",
            "https://tauri.localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            assert!(
                is_allowed_navigation(&Url::parse(value).expect("valid URL")),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_deceptive_hosts_credentials_and_ports() {
        for value in [
            "https://tauri.localhost.example.invalid/",
            "https://tauri.localhost:444/",
            "https://user@tauri.localhost/",
            "https://example.invalid/",
        ] {
            assert!(
                !is_allowed_navigation(&Url::parse(value).expect("valid URL")),
                "{value}"
            );
        }
    }
}

#[cfg(all(test, feature = "file-test"))]
mod confirmation_tests {
    use super::{ConfirmationSession, DeviceReviewDetails, PendingConfirmation, fresh_preview_id};
    use ais_host_core::{
        device::{DeviceObservation, WritePlan, WriteTarget},
        file_test::{FileTarget, SyntheticRelease},
    };
    use std::time::{Duration, Instant};

    fn pending_for(device: DeviceObservation, preview_id: &str) -> PendingConfirmation {
        let release = SyntheticRelease::new(vec![0x53; 512]);
        let (_, image) = release.verify(&std::env::temp_dir()).unwrap();
        let plan = WritePlan::synthetic_image(&image, device.clone()).unwrap();
        PendingConfirmation {
            preview_id: preview_id.to_string(),
            plan,
            image,
            details: DeviceReviewDetails::default(),
            ticket: None,
        }
    }

    fn fixture(preview_id: &str) -> (PendingConfirmation, DeviceObservation) {
        let target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
        let device = target.observe().unwrap();
        (pending_for(device.clone(), preview_id), device)
    }

    fn session_with_fixture() -> (ConfirmationSession, DeviceObservation, String) {
        let (pending, device) = fixture("PREVIEW_SYNTHETIC_FIXTURE_1");
        let preview_id = pending.preview_id.clone();
        let session = ConfirmationSession::default();
        session.state.lock().unwrap().pending = Some(pending);
        (session, device, preview_id)
    }

    #[test]
    fn exact_typed_confirmation_expires_against_injected_clock() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        let receipt = session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        assert_eq!(receipt.expires_in_seconds, 90);
        assert!(
            session
                .consume(&preview_id, &device, now + Duration::from_secs(90))
                .is_err()
        );
        assert!(
            session
                .consume(&preview_id, &device, now + Duration::from_secs(91))
                .is_err()
        );
    }

    #[test]
    fn confirmation_ticket_is_single_use() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        session.consume(&preview_id, &device, now).unwrap();
        assert!(session.consume(&preview_id, &device, now).is_err());
    }

    #[test]
    fn independently_generated_preview_ids_do_not_reuse_plan_identity() {
        assert_ne!(fresh_preview_id().unwrap(), fresh_preview_id().unwrap());
    }

    #[test]
    fn a_wrong_second_typed_attempt_invalidates_the_first_ticket() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        assert!(
            session
                .confirm(&preview_id, "WRONG_SYNTHETIC_FIXTURE", now)
                .is_err()
        );
        assert!(session.consume(&preview_id, &device, now).is_err());
    }

    #[test]
    fn refresh_invalidates_ticket_and_native_preview() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        session.invalidate();
        assert!(session.consume(&preview_id, &device, now).is_err());
        assert!(
            session
                .confirm(&preview_id, &device.display_identifier, now)
                .is_err()
        );
    }

    #[test]
    fn refreshed_identical_plan_gets_a_new_preview_identifier() {
        let (session, device, old_preview_id) = session_with_fixture();
        session.invalidate();
        let new_pending = pending_for(device.clone(), "PREVIEW_SYNTHETIC_FIXTURE_2");
        let new_preview_id = new_pending.preview_id.clone();
        session.state.lock().unwrap().pending = Some(new_pending);

        assert_ne!(old_preview_id, new_preview_id);
        session
            .confirm(&new_preview_id, &device.display_identifier, Instant::now())
            .unwrap();
        assert!(
            session
                .confirm(&old_preview_id, &device.display_identifier, Instant::now(),)
                .is_err()
        );
    }

    #[test]
    fn typed_identifier_must_match_native_preview_exactly() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        assert!(
            session
                .confirm(&preview_id, &format!(" {}", device.display_identifier), now)
                .is_err()
        );
        assert!(session.consume(&preview_id, &device, now).is_err());
    }

    #[test]
    fn renderer_cannot_substitute_a_preview_plan() {
        // The only installation function takes a VerifiedImage and observation
        // as Rust values. Tauri command DTOs contain neither type.
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&format!("{preview_id}0"), &device.display_identifier, now)
            .unwrap_err();
        assert!(session.consume(&preview_id, &device, now).is_err());
    }
}
