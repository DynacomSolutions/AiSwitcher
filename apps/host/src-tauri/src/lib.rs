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
            start_write,
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
    native_devices()
}

#[cfg(target_os = "linux")]
fn native_devices() -> Vec<ais_host_core::device::DeviceSummary> {
    ais_host_helper::platform::list_linux_eligible()
        .into_iter()
        .map(|(disk, model)| ais_host_core::device::DeviceSummary {
            id: disk.observation.os_identity.clone(),
            display_identifier: disk.observation.display_identifier.clone(),
            model,
            capacity_bytes: disk.observation.capacity_bytes,
            transport: "usb".to_string(),
            system: disk.observation.system_backing,
            writable: disk.observation.writable,
            serial: disk.observation.serial.clone(),
            layout_status: "unknown".to_string(),
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn native_devices() -> Vec<ais_host_core::device::DeviceSummary> {
    Vec::new()
}

/// The webview supplies only the native device selector. The verified image
/// comes from the bundled-key release path and the device observation from the
/// privileged helper's read-only preview, so the plan is built natively.
#[tauri::command]
fn preview_write(
    device_id: String,
    state: tauri::State<'_, ConfirmationSession>,
) -> Result<WritePreview, String> {
    state.invalidate();
    if device_id.is_empty() || device_id.len() > 256 || device_id.chars().any(char::is_control) {
        return Err("The selected device is unavailable.".to_string());
    }
    // Fail closed before any prompt or download when no trusted key is bundled.
    let verifier =
        ais_host_core::release::ImageVerifier::bundled().map_err(|error| error.to_string())?;
    let fetched = ais_host_core::fetch::fetch_verified(
        &ais_host_core::fetch::UreqHttp::default(),
        &verifier,
        RELEASE_LISTING,
        &std::env::temp_dir(),
    )
    .map_err(|error| error.to_string())?;
    let observation = preview_native(&device_id)?;
    let details = DeviceReviewDetails {
        model: None,
        partitions: Vec::new(),
        partition_details_available: false,
    };
    state.install_native_preview(
        fetched.image,
        fetched.release,
        observation,
        details,
        fetched.sources,
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
    native_write_support()
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

#[allow(dead_code)] // used by native preview installation
fn fresh_preview_id() -> Result<String, String> {
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce).map_err(|_| "Unable to create a preview identifier.")?;
    Ok(ais_host_core::release::hex(&nonce))
}

#[allow(dead_code)] // installed by native discovery, which is not wired yet
struct PendingConfirmation {
    preview_id: String,
    plan: ais_host_core::device::WritePlan,
    image: ais_host_core::release::VerifiedImage,
    /// The published release the verified image came from; the helper selects
    /// and re-verifies the same assets from it.
    release: ais_host_core::release::PublishedRelease,
    details: DeviceReviewDetails,
    ticket: Option<ais_host_core::device::ConfirmationTicket>,
    /// Exact typed text and the moment it was accepted, for the helper request.
    typed: Option<(String, Instant)>,
    /// Retained image, checksum and signature files for the helper to re-verify.
    sources: Option<[std::fs::File; 3]>,
}

/// Presentation fields are collected by the native enumerator. They never
/// provide authority to create a plan or target a device.
#[derive(Default)]
#[allow(dead_code)] // filled by native discovery
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
        pending.typed = Some((typed_identifier.to_owned(), now));
        Ok(ConfirmationReceipt {
            expires_in_seconds: CONFIRMATION_TTL.as_secs(),
        })
    }

    #[allow(dead_code)] // called by native discovery, which is not wired yet
    fn install_native_preview(
        &self,
        image: ais_host_core::release::VerifiedImage,
        release: ais_host_core::release::PublishedRelease,
        device: ais_host_core::device::DeviceObservation,
        details: DeviceReviewDetails,
        sources: [std::fs::File; 3],
    ) -> Result<WritePreview, String> {
        let mut pending = PendingConfirmation::from_native(image, release, device, details)?;
        pending.sources = Some(sources);
        let preview = pending.view();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        state.approvals.invalidate();
        state.pending = Some(pending);
        Ok(preview)
    }

    /// Consume the typed-confirmation ticket against a fresh native observation
    /// and hand one request to the privileged helper. Writes stay disabled until
    /// the verified-image support gate reports enabled; every other path consumes
    /// the ticket and the preview.
    fn begin_write(
        &self,
        preview_id: &str,
        now: Instant,
        support: &ais_host_core::device::WriteSupport,
        observe: &dyn Fn(
            &ais_host_core::device::DeviceObservation,
        ) -> Result<ais_host_core::device::DeviceObservation, String>,
        launcher: &dyn HelperLauncher,
    ) -> Result<(), String> {
        if !support.enabled {
            self.invalidate();
            return Err(support.reason.to_string());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        let ConfirmationState { pending, approvals } = &mut *state;
        let Some(mut current) = pending
            .take()
            .filter(|pending| pending.preview_id == preview_id)
        else {
            approvals.invalidate();
            return Err("The preview is unavailable or expired.".to_string());
        };
        let ticket = current
            .ticket
            .take()
            .ok_or("Typed confirmation is required.")?;
        let (typed, confirmed_at) = current
            .typed
            .take()
            .ok_or("Typed confirmation is required.")?;
        let observation = observe(current.plan.device())?;
        approvals
            .consume(&ticket, &current.plan, &observation, &current.image, now)
            .map_err(|error| error.to_string())?;
        let remaining =
            CONFIRMATION_TTL.saturating_sub(now.saturating_duration_since(confirmed_at));
        let request = helper_request(&current, typed, remaining)?;
        let sources = current
            .sources
            .as_ref()
            .ok_or("The verified image sources are unavailable.")?;
        launcher.launch(request, sources)
    }
}

/// The helper re-derives the plan from its own verified image and native
/// observation, so this carries only identifiers, the digest and the deadline.
fn helper_request(
    pending: &PendingConfirmation,
    typed: String,
    remaining: std::time::Duration,
) -> Result<ais_host_helper::protocol::Request, String> {
    let operation = match pending.plan.operation() {
        ais_host_core::device::WriteOperation::CreateLayout => {
            ais_host_helper::protocol::Operation::CreateLayout
        }
        ais_host_core::device::WriteOperation::ReplaceBase => {
            ais_host_helper::protocol::Operation::ReplaceBase
        }
        ais_host_core::device::WriteOperation::ResetPersist => {
            ais_host_helper::protocol::Operation::ResetPersist
        }
    };
    Ok(ais_host_helper::protocol::Request {
        version: 1,
        operation,
        plan_digest: ais_host_core::release::hex(&pending.plan.digest()),
        // Bound to the helper's session challenge by the launcher.
        channel_binding: "0".repeat(64),
        ticket: fresh_preview_id()?,
        release: pending.release.clone(),
        device_identity: pending.plan.device().os_identity.clone(),
        typed_confirmation: typed,
        confirmation_deadline_boot_ns: deadline_boot_ns(remaining)?,
    })
}

#[cfg(target_os = "linux")]
fn deadline_boot_ns(remaining: std::time::Duration) -> Result<u64, String> {
    let now = ais_host_helper::protocol::linux_transport::boottime_ns()
        .map_err(|_| "The boot clock is unavailable.")?;
    let remaining = u64::try_from(remaining.as_nanos()).map_err(|_| "Invalid expiry.")?;
    Ok(now + remaining)
}

#[cfg(not(target_os = "linux"))]
fn deadline_boot_ns(_remaining: std::time::Duration) -> Result<u64, String> {
    Err("This operating system has no enabled authenticated helper.".to_string())
}

/// Starts the per-OS privileged helper for one request.
trait HelperLauncher {
    fn launch(
        &self,
        request: ais_host_helper::protocol::Request,
        sources: &[std::fs::File; 3],
    ) -> Result<(), String>;
}

/// The installed per-OS helper. Only Linux has an authenticated transport.
struct NativeHelper;

impl HelperLauncher for NativeHelper {
    #[cfg(target_os = "linux")]
    fn launch(
        &self,
        request: ais_host_helper::protocol::Request,
        sources: &[std::fs::File; 3],
    ) -> Result<(), String> {
        let uid = ais_host_helper::protocol::linux_transport::current_uid();
        ais_host_helper::protocol::linux_transport::run_session(
            uid,
            [&sources[0], &sources[1], &sources[2]],
            request,
        )
        .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "linux"))]
    fn launch(
        &self,
        _request: ais_host_helper::protocol::Request,
        _sources: &[std::fs::File; 3],
    ) -> Result<(), String> {
        Err(ais_host_helper::platform::unavailable_reason().to_string())
    }
}

/// Writes are offered only when the root-owned helper package verifies and the
/// bundled production release key exists. The placeholder key keeps this off.
fn native_write_support() -> ais_host_core::device::WriteSupport {
    let key_present = ais_host_core::release::ImageVerifier::bundled().is_ok();
    #[cfg(target_os = "linux")]
    let helper = ais_host_helper::protocol::linux_transport::helper_installed();
    #[cfg(not(target_os = "linux"))]
    let helper = false;
    let (enabled, reason) = match (key_present, helper) {
        (true, true) => (true, "Ready."),
        (false, _) => (
            false,
            "The production image signing key is not bundled in this build.",
        ),
        (_, false) => (
            false,
            "The ais host helper package is not installed or does not verify.",
        ),
    };
    ais_host_core::device::WriteSupport { enabled, reason }
}

#[cfg(target_os = "linux")]
fn observe_native(
    approved: &ais_host_core::device::DeviceObservation,
) -> Result<ais_host_core::device::DeviceObservation, String> {
    ais_host_helper::platform::observe_linux_unprivileged(approved)
        .map_err(|_| "The selected device is unavailable.".to_string())
}

#[cfg(not(target_os = "linux"))]
fn observe_native(
    _approved: &ais_host_core::device::DeviceObservation,
) -> Result<ais_host_core::device::DeviceObservation, String> {
    Err("The selected device is unavailable.".to_string())
}

#[cfg(target_os = "linux")]
fn preview_native(identity: &str) -> Result<ais_host_core::device::DeviceObservation, String> {
    ais_host_helper::protocol::linux_transport::preview_observation(identity)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "linux"))]
fn preview_native(_identity: &str) -> Result<ais_host_core::device::DeviceObservation, String> {
    Err(ais_host_helper::platform::unavailable_reason().to_string())
}

const RELEASE_LISTING: &str =
    "https://api.github.com/repos/DynacomSolutions/AiSwitcher/releases?per_page=30";

/// Takes only the preview identifier; the plan, ticket and image stay native.
#[tauri::command]
fn start_write(
    preview_id: String,
    state: tauri::State<'_, ConfirmationSession>,
) -> Result<(), String> {
    state.begin_write(
        &preview_id,
        Instant::now(),
        &native_write_support(),
        &observe_native,
        &NativeHelper,
    )
}

impl PendingConfirmation {
    /// This constructor takes only native-owned values and is intentionally
    /// private to the command module. No IPC type can deserialize a plan.
    #[allow(dead_code)] // called by native discovery, which is not wired yet
    fn from_native(
        image: ais_host_core::release::VerifiedImage,
        release: ais_host_core::release::PublishedRelease,
        device: ais_host_core::device::DeviceObservation,
        details: DeviceReviewDetails,
    ) -> Result<Self, String> {
        let plan = ais_host_core::device::WritePlan::create_layout(&image, device)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            preview_id: fresh_preview_id()?,
            plan,
            image,
            release,
            details,
            ticket: None,
            typed: None,
            sources: None,
        })
    }

    #[allow(dead_code)] // called by native discovery, which is not wired yet
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

#[cfg(all(test, feature = "file-test", target_os = "linux"))]
mod confirmation_tests {
    use super::{
        ConfirmationSession, DeviceReviewDetails, HelperLauncher, PendingConfirmation,
        fresh_preview_id,
    };
    use ais_host_core::{
        device::{DeviceObservation, WritePlan, WriteTarget},
        file_test::{FileTarget, SyntheticRelease},
    };
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Recorder(std::cell::RefCell<Vec<ais_host_helper::protocol::Request>>);

    impl HelperLauncher for Recorder {
        fn launch(
            &self,
            request: ais_host_helper::protocol::Request,
            _sources: &[std::fs::File; 3],
        ) -> Result<(), String> {
            self.0.borrow_mut().push(request);
            Ok(())
        }
    }

    fn support(enabled: bool) -> ais_host_core::device::WriteSupport {
        ais_host_core::device::WriteSupport {
            enabled,
            reason: "SYNTHETIC_FIXTURE disabled",
        }
    }

    fn sources() -> [std::fs::File; 3] {
        let open = || std::fs::File::open("/dev/null").unwrap();
        [open(), open(), open()]
    }

    fn published_release() -> ais_host_core::release::PublishedRelease {
        serde_json::from_value(serde_json::json!({
            "id": 1, "tag": "live-v1.0.0", "publishedAt": 1, "draft": false, "prerelease": false,
            "assets": [
                { "id": 1, "name": "ais-live-x86_64-live-v1.0.0.img.zst", "size": 1, "revision": "SYNTHETIC_FIXTURE" },
                { "id": 2, "name": "SHA256SUMS", "size": 1, "revision": "SYNTHETIC_FIXTURE" },
                { "id": 3, "name": "SHA256SUMS.minisig", "size": 1, "revision": "SYNTHETIC_FIXTURE" }
            ]
        }))
        .unwrap()
    }

    fn launch_with(
        session: &ConfirmationSession,
        preview_id: &str,
        device: &DeviceObservation,
        now: Instant,
        enabled: bool,
        launcher: &Recorder,
    ) -> Result<(), String> {
        session.begin_write(
            preview_id,
            now,
            &support(enabled),
            &|_| Ok(device.clone()),
            launcher,
        )
    }

    fn consume(
        session: &ConfirmationSession,
        preview_id: &str,
        device: &DeviceObservation,
        now: Instant,
    ) -> Result<(), String> {
        launch_with(session, preview_id, device, now, true, &Recorder::default())
    }

    fn pending_for(device: DeviceObservation, preview_id: &str) -> PendingConfirmation {
        let release = SyntheticRelease::new(vec![0x53; 512]);
        let (_, image) = release.verify(&std::env::temp_dir()).unwrap();
        let plan = WritePlan::synthetic_image(&image, device.clone()).unwrap();
        PendingConfirmation {
            preview_id: preview_id.to_string(),
            plan,
            image,
            release: published_release(),
            details: DeviceReviewDetails::default(),
            ticket: None,
            typed: None,
            sources: Some(sources()),
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
            consume(
                &session,
                &preview_id,
                &device,
                now + Duration::from_secs(90)
            )
            .is_err()
        );
        assert!(
            consume(
                &session,
                &preview_id,
                &device,
                now + Duration::from_secs(91)
            )
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
        consume(&session, &preview_id, &device, now).unwrap();
        assert!(consume(&session, &preview_id, &device, now).is_err());
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
        assert!(consume(&session, &preview_id, &device, now).is_err());
    }

    #[test]
    fn refresh_invalidates_ticket_and_native_preview() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        session.invalidate();
        assert!(consume(&session, &preview_id, &device, now).is_err());
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
        assert!(consume(&session, &preview_id, &device, now).is_err());
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
        assert!(consume(&session, &preview_id, &device, now).is_err());
    }

    #[test]
    fn disabled_write_support_never_reaches_the_helper_and_drops_the_preview() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        let launcher = Recorder::default();
        let error = launch_with(&session, &preview_id, &device, now, false, &launcher).unwrap_err();
        assert_eq!(error, "SYNTHETIC_FIXTURE disabled");
        assert!(launcher.0.borrow().is_empty());
        assert!(launch_with(&session, &preview_id, &device, now, true, &launcher).is_err());
    }

    #[test]
    fn helper_request_carries_the_plan_digest_and_typed_text_once() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        let launcher = Recorder::default();
        launch_with(&session, &preview_id, &device, now, true, &launcher).unwrap();
        let requests = launcher.0.borrow();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].device_identity, device.os_identity);
        assert_eq!(requests[0].typed_confirmation, device.display_identifier);
        assert_eq!(requests[0].plan_digest.len(), 64);
        drop(requests);
        assert!(launch_with(&session, &preview_id, &device, now, true, &launcher).is_err());
        assert_eq!(launcher.0.borrow().len(), 1);
    }

    #[test]
    fn a_changed_device_observation_refuses_before_the_helper() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        let mut changed = device.clone();
        changed.table_fingerprint = [0x11; 32];
        let launcher = Recorder::default();
        assert!(launch_with(&session, &preview_id, &changed, now, true, &launcher).is_err());
        assert!(launcher.0.borrow().is_empty());
    }
}
