mod escrow_commands;

use std::time::Instant;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ConfirmationSession::default())
        .setup(|app| {
            let data = app
                .path()
                .app_data_dir()
                .map_err(|_| "missing application data directory")?
                .join("escrow");
            std::fs::create_dir_all(&data)?;
            #[cfg(unix)]
            std::fs::set_permissions(&data, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
            // Without a private registry the create flow refuses to write.
            if let Ok(state) = escrow_commands::EscrowCommandState::new(data) {
                let _ = state.purge();
                app.manage(state);
            }
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
            preview_update,
            confirm_write,
            start_write,
            list_models,
            escrow_commands::escrow_drive_records,
            escrow_commands::escrow_purge,
            escrow_commands::escrow_delete,
            set_create_options,
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
async fn list_devices(
    app: tauri::AppHandle,
) -> Result<Vec<ais_host_core::device::DeviceSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app
            .try_state::<escrow_commands::EscrowCommandState>()
            .ok_or("The local drive registry is unavailable.")?;
        inspect_devices(&app.state::<ConfirmationSession>(), &registry)
    })
    .await
    .map_err(|_| "Connected drives could not be inspected.".to_string())?
}

fn inspect_devices(
    state: &ConfirmationSession,
    registry: &escrow_commands::EscrowCommandState,
) -> Result<Vec<ais_host_core::device::DeviceSummary>, String> {
    let _media = state.lock_media()?;
    let devices = native_devices();
    let images = registry.known_images().unwrap_or_default();
    let hints: Vec<_> = devices
        .iter()
        .map(ais_host_core::update::hardware_hint)
        .collect();
    let mut summaries = state.retain_listed(devices);
    for (summary, hint) in summaries.iter_mut().zip(hints) {
        let matches: Vec<_> = images
            .iter()
            .filter(|(image, _)| image.hardware_hint == hint)
            .collect();
        // Registry status only: the journal is read and authenticated when the
        // user starts the update, so refreshing the list never prompts for root.
        if let [(_, status)] = matches.as_slice() {
            summary.layout_status = match status.as_str() {
                "updating" => "update incomplete",
                "writtenAwaitingBoot" => "awaiting boot",
                _ => "ready",
            }
            .into();
        }
    }
    Ok(summaries)
}

#[cfg(target_os = "linux")]
fn native_devices() -> Vec<ais_host_core::device::DeviceObservation> {
    ais_host_helper::platform::list_linux_eligible()
        .into_iter()
        .map(|(disk, _)| disk.observation)
        .collect()
}

#[cfg(target_os = "macos")]
fn native_devices() -> Vec<ais_host_core::device::DeviceObservation> {
    ais_host_helper::platform::list_macos_eligible()
        .into_iter()
        .map(|disk| disk.observation)
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn native_devices() -> Vec<ais_host_core::device::DeviceObservation> {
    Vec::new()
}

/// The webview supplies only the native device selector. The verified image
/// comes from the bundled-key release path and the device observation from the
/// privileged helper's read-only preview, so the plan is built natively.
#[tauri::command]
async fn preview_write(device_id: String, app: tauri::AppHandle) -> Result<WritePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_blocking(&device_id, &app))
        .await
        .map_err(|_| "The preview could not be prepared.".to_string())?
}

fn preview_blocking(device_id: &str, app: &tauri::AppHandle) -> Result<WritePreview, String> {
    let state = app.state::<ConfirmationSession>();
    let mut preparation = state.begin_preview(device_id)?;
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
    let observation = preview_native(device_id)?;
    preparation.check_observation(&observation)?;
    let catalogue =
        ais_host_core::create::Catalogue::parse(ais_host_core::create::BUNDLED_CATALOGUE)
            .map_err(|error| error.to_string())?;
    let model = ais_host_core::create::check_capacity(
        &preparation.create.options,
        &catalogue,
        fetched.image.len(),
        observation.capacity_bytes,
    )
    .map_err(|error| error.to_string())?;
    // The model is downloaded and verified before the user can confirm, so a
    // bad pin, short download or full disk never reaches the destructive step.
    if let Some(entry) = model {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| "The cache directory is unavailable.".to_string())?
            .join("models");
        preparation.create.model = Some(
            ais_host_core::model::obtain_model(
                &ais_host_core::fetch::UreqHttp::for_hosts(ais_host_core::model::MODEL_HOSTS),
                &entry,
                &cache,
            )
            .map_err(|error| error.to_string())?,
        );
    }
    let details = DeviceReviewDetails {
        partitions: Vec::new(),
        partition_details_available: false,
    };
    state.install_native_preview(
        fetched.image,
        fetched.release,
        observation,
        details,
        fetched.sources,
        preparation,
    )
}

/// The stored release and actual GPT must both identify a drive created here.
#[tauri::command]
async fn preview_update(device_id: String, app: tauri::AppHandle) -> Result<WritePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ConfirmationSession>();
        let _media = state.lock_media()?;
        let preparation = state.begin_preview(&device_id)?;
        let snapshot = preview_update_native(&device_id)?;
        preparation.check_observation(&snapshot.observation)?;
        let images = app
            .try_state::<escrow_commands::EscrowCommandState>()
            .ok_or("The local drive registry is unavailable.")?
            .known_images()?;
        let matches: Vec<_> = images
            .into_iter()
            .filter(|(image, _)| snapshot.partitions(&image.identity).is_ok())
            .collect();
        if matches.len() != 1 {
            return Err("The drive's installed release is unknown or its layout changed.".into());
        }
        let (registered, status) = matches.into_iter().next().expect("one known drive");
        let existing = inspect_journal(&UdisksVolume, &snapshot, &registered)?;
        if existing.is_none() && status == "updating" {
            return Err("The update journal is missing. The interrupted release cannot be identified safely.".into());
        }
        let interrupted = existing
            .as_ref()
            .map(|sealed| {
                let journal = sealed.authenticate(preparation.create.passphrase.expose())?;
                journal.check_drive(&snapshot, &registered, &status)?;
                Ok::<_, String>(journal)
            })
            .transpose()?;
        let verifier =
            ais_host_core::release::ImageVerifier::bundled().map_err(|error| error.to_string())?;
        let http = ais_host_core::fetch::UreqHttp::default();
        let fetched = match &interrupted {
            Some(journal) => ais_host_core::fetch::fetch_verified_tag(
                &http,
                &verifier,
                journal.tag(),
                journal.image_digest(),
                &std::env::temp_dir(),
            ),
            None => ais_host_core::fetch::fetch_verified(
                &http,
                &verifier,
                RELEASE_LISTING,
                &std::env::temp_dir(),
            ),
        }
        .map_err(|error| error.to_string())?;
        let snapshot = preview_update_native(&device_id)?;
        preparation.check_observation(&snapshot.observation)?;
        let journal = match interrupted {
            Some(journal) => journal,
            None => ais_host_core::update_journal::UpdateJournal::new(
                &fetched.image,
                registered.clone(),
            )?,
        };
        journal.check_drive(&snapshot, &registered, &status)?;
        journal.check_image(&fetched.image)?;
        let installed = journal.previous().clone();
        let plan =
            ais_host_core::device::WritePlan::update_drive(&fetched.image, &snapshot, &installed)
                .map_err(|_| {
                "A newer compatible image is required. Its base must fit the existing partition."
                    .to_string()
            })?;
        let parts = snapshot
            .partitions(&installed.identity)
            .map_err(|_| "The drive layout changed.")?;
        let details = DeviceReviewDetails {
            partitions: parts
                .iter()
                .enumerate()
                .map(|(index, part)| PartitionReview {
                    name: ["BIOS", "AISBOOT", "AISBASE", "AISX", "AISPERSIST"][index].into(),
                    size_bytes: ais_host_core::update::partition_range(part).length,
                    kind: if index < 3 { "replace" } else { "preserve" }.into(),
                })
                .collect(),
            partition_details_available: true,
        };
        let pending = PendingConfirmation {
            preview_id: fresh_preview_id()?,
            plan,
            image: fetched.image,
            release: fetched.release,
            details,
            ticket: None,
            typed: None,
            sources: Some(fetched.sources),
            create: Some(preparation.create),
            installed: Some(installed),
            update: Some(PreparedUpdate { journal, existing }),
        };
        let view = pending.view();
        let mut locked = state
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        if locked.preparing.as_deref() != Some(&preparation.id) {
            return Err("The update choices changed during preparation.".into());
        }
        locked.preparing = None;
        locked.approvals.invalidate();
        locked.pending = Some(pending);
        Ok(view)
    })
    .await
    .map_err(|_| "The update preview could not be prepared.".to_string())?
}
#[cfg(target_os = "linux")]
fn preview_update_native(id: &str) -> Result<ais_host_core::update::DriveSnapshot, String> {
    ais_host_helper::protocol::linux_transport::preview_update(id)
        .map_err(|error| error.to_string())
}
#[cfg(target_os = "macos")]
fn preview_update_native(id: &str) -> Result<ais_host_core::update::DriveSnapshot, String> {
    ais_host_helper::protocol::macos_transport::preview_update(id)
        .map_err(|error| error.to_string())
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn preview_update_native(_: &str) -> Result<ais_host_core::update::DriveSnapshot, String> {
    Err("Image updates are unavailable on this platform.".into())
}

/// The reviewed model catalogue with immutable download pins.
#[tauri::command]
fn list_models() -> Result<Vec<ais_host_core::create::ModelEntry>, String> {
    ais_host_core::create::Catalogue::parse(ais_host_core::create::BUNDLED_CATALOGUE)
        .map(|catalogue| catalogue.models)
        .map_err(|error| error.to_string())
}

/// Validate the create choices and keep them natively for the next preview.
/// The passphrase never reaches the helper; it is held only until the write
/// finishes, then handed to the escrow seam and dropped.
#[tauri::command]
fn set_create_options(
    model_id: Option<String>,
    licence_accepted: bool,
    passphrase: String,
    confirmation: String,
    state: tauri::State<'_, ConfirmationSession>,
) -> Result<(), String> {
    let passphrase = ais_host_core::create::Passphrase::new(passphrase, &confirmation)
        .map_err(|error| error.to_string())?;
    let options = ais_host_core::create::CreateOptions {
        model_id,
        licence_accepted,
    };
    let catalogue =
        ais_host_core::create::Catalogue::parse(ais_host_core::create::BUNDLED_CATALOGUE)
            .map_err(|error| error.to_string())?;
    ais_host_core::create::check_capacity(&options, &catalogue, 0, u64::MAX / 2)
        .map_err(|error| error.to_string())?;
    state.set_create(StoredCreate {
        options,
        passphrase,
        model: None,
    })
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
    serial: Option<String>,
    connection_identity: String,
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

struct StoredCreate {
    options: ais_host_core::create::CreateOptions,
    passphrase: ais_host_core::create::Passphrase,
    /// The pinned model, downloaded and verified before confirmation.
    model: Option<ais_host_core::model::VerifiedModel>,
}

struct PreviewPreparation {
    id: String,
    create: StoredCreate,
    listed: ais_host_core::device::DeviceObservation,
}

impl PreviewPreparation {
    fn check_observation(
        &self,
        current: &ais_host_core::device::DeviceObservation,
    ) -> Result<(), String> {
        if !self.listed.same_physical_identity(current) {
            return Err(
                "The listed drive changed. Refresh the devices and select it again.".into(),
            );
        }
        Ok(())
    }
}

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
    create: Option<StoredCreate>,
    installed: Option<ais_host_core::update::InstalledImage>,
    update: Option<PreparedUpdate>,
}

struct PreparedUpdate {
    journal: ais_host_core::update_journal::UpdateJournal,
    existing: Option<ais_host_core::update_journal::SealedJournal>,
}

/// Read only through the verified partition handle, and release the mount
/// before the helper re-observes the unmounted disk.
fn inspect_journal(
    volume: &dyn ExchangeVolume,
    snapshot: &ais_host_core::update::DriveSnapshot,
    installed: &ais_host_core::update::InstalledImage,
) -> Result<Option<ais_host_core::update_journal::SealedJournal>, String> {
    let parts = snapshot
        .partitions(&installed.identity)
        .map_err(|_| "The drive's disk or partition identities changed.")?;
    let root = volume.mount_parts(
        &snapshot.observation,
        ais_host_core::update::partition_range(&parts[3]),
        &installed.identity,
    )?;
    let result = ais_host_core::update_journal::SealedJournal::load(&root);
    drop(root);
    let unmounted = volume.unmount(&snapshot.observation);
    let journal = result?;
    unmounted?;
    Ok(journal)
}

/// Presentation fields are collected by the native enumerator. They never
/// provide authority to create a plan or target a device.
#[derive(Default)]
#[allow(dead_code)] // filled by native discovery
struct DeviceReviewDetails {
    partitions: Vec<PartitionReview>,
    partition_details_available: bool,
}

/// Session-scoped confirmation authority. Only native code can install a
/// preview; the webview can request an exact identifier check and invalidate it.
#[derive(Default)]
struct ConfirmationSession {
    state: std::sync::Mutex<ConfirmationState>,
    /// Journal inspection mounts exchange, so it must not overlap a raw write.
    media: std::sync::Mutex<()>,
}

#[derive(Default)]
struct ConfirmationState {
    listed: Vec<ais_host_core::device::DeviceObservation>,
    pending: Option<PendingConfirmation>,
    /// Invalidating the session also cancels any preview still downloading.
    preparing: Option<String>,
    /// Validated create options awaiting a preview; cleared by any invalidation.
    create: Option<StoredCreate>,
    approvals: ais_host_core::device::ConfirmationBook,
}

impl ConfirmationSession {
    fn lock_media(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.media.try_lock().map_err(|_| {
            "Drive inspection or writing is already in progress. Try again when it finishes.".into()
        })
    }

    fn retain_listed(
        &self,
        devices: Vec<ais_host_core::device::DeviceObservation>,
    ) -> Vec<ais_host_core::device::DeviceSummary> {
        self.invalidate();
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        state.listed = devices;
        state
            .listed
            .iter()
            .map(|device| ais_host_core::device::DeviceSummary {
                id: device.os_identity.clone(),
                display_identifier: device.display_identifier.clone(),
                model: device.model.clone(),
                capacity_bytes: device.capacity_bytes,
                transport: "usb".into(),
                system: device.system_backing,
                writable: device.writable,
                serial: device.serial.clone(),
                layout_status: "unknown".into(),
                update_error: None,
            })
            .collect()
    }

    fn invalidate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.pending = None;
            state.preparing = None;
            state.create = None;
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
        let ConfirmationState {
            pending, approvals, ..
        } = &mut *state;
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

    fn install_native_preview(
        &self,
        image: ais_host_core::release::VerifiedImage,
        release: ais_host_core::release::PublishedRelease,
        device: ais_host_core::device::DeviceObservation,
        details: DeviceReviewDetails,
        sources: [std::fs::File; 3],
        preparation: PreviewPreparation,
    ) -> Result<WritePreview, String> {
        preparation.check_observation(&device)?;
        let mut pending = PendingConfirmation::from_native(image, release, device, details)?;
        pending.sources = Some(sources);
        pending.create = Some(preparation.create);
        let preview = pending.view();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        if state.preparing.as_deref() != Some(&preparation.id) {
            return Err("The create choices changed while the preview was being prepared.".into());
        }
        state.preparing = None;
        state.approvals.invalidate();
        state.pending = Some(pending);
        Ok(preview)
    }

    fn set_create(&self, create: StoredCreate) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        state.pending = None;
        state.preparing = None;
        state.approvals.invalidate();
        state.create = Some(create);
        Ok(())
    }

    fn begin_preview(&self, device_id: &str) -> Result<PreviewPreparation, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        state.pending = None;
        state.preparing = None;
        state.approvals.invalidate();
        let listed = state
            .listed
            .iter()
            .find(|device| device.os_identity == device_id)
            .cloned()
            .ok_or("Refresh the devices and select a listed drive.")?;
        let create = state
            .create
            .take()
            .ok_or_else(|| "Choose the drive options first.".to_string())?;
        let id = fresh_preview_id()?;
        state.preparing = Some(id.clone());
        Ok(PreviewPreparation { id, create, listed })
    }

    /// Consume the typed-confirmation ticket against a fresh native observation
    /// and hand one request to the privileged helper. Writes stay disabled until
    /// the verified-image support gate reports enabled; every other path consumes
    /// the ticket and the preview.
    fn begin_write(
        &self,
        preview_id: &str,
        now: Instant,
        env: &mut WriteEnv<'_>,
    ) -> Result<(), String> {
        let _media = self.lock_media()?;
        let started = Instant::now();
        if !env.support.enabled {
            self.invalidate();
            return Err(env.support.reason.to_string());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Confirmation state is unavailable.")?;
        let ConfirmationState {
            pending, approvals, ..
        } = &mut *state;
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
        let observation = (env.observe)(current.plan.device())?;
        approvals
            .consume(&ticket, &current.plan, &observation, &current.image, now)
            .map_err(|error| error.to_string())?;
        drop(state);
        if current.installed.is_some() {
            return perform_update(
                current,
                typed,
                CONFIRMATION_TTL
                    .saturating_sub(now.saturating_duration_since(confirmed_at))
                    .saturating_sub(started.elapsed()),
                env,
            );
        }
        let mut create = current
            .create
            .take()
            .ok_or("Choose the drive options first.")?;
        let snapshot = ais_host_core::flow_adapter::SourceSnapshot::read(
            env.adapter,
            &ais_host_core::flow_adapter::HostTarget::new("local")?,
        )?;
        let inbox =
            ais_host_core::publish::prepare_first_inbox(&snapshot, create.passphrase.expose())?;
        drop(snapshot);
        let mut model_snapshot = create
            .model
            .as_mut()
            .map(ais_host_core::publish::snapshot_model)
            .transpose()?;
        let remaining = CONFIRMATION_TTL
            .saturating_sub(now.saturating_duration_since(confirmed_at))
            .saturating_sub(started.elapsed());
        let request = helper_request(&current, typed, remaining)?;
        let sources = current
            .sources
            .as_ref()
            .ok_or("The verified image sources are unavailable.")?;
        env.launcher.launch(request, sources)?;
        // Past this point the drive is written but not ready: nothing is
        // registered and the user must start again with a new confirmation.
        let device = current.plan.device();
        let exchange = match env.volume.mount(&current.plan) {
            Ok(path) => path,
            Err(_) => {
                // A mount can succeed before its verification fails. Attempt
                // safe cleanup against the same connection in either case.
                let _ = env.volume.eject(device);
                return Err("The drive was written, but its exchange partition could not be opened. Reconnect it and create the drive again.".into());
            }
        };
        let not_ready = |_: String| {
            "The drive was written, but its configuration could not be published and verified. Create the drive again.".to_string()
        };
        let publication = (|| {
            inbox.publish(&exchange)?;
            if let Some(model) = model_snapshot.as_mut() {
                ais_host_core::publish::publish_model(&exchange, model)?;
            }
            ais_host_core::publish::verify_published(
                &exchange,
                create.passphrase.expose(),
                model_snapshot.as_ref().map(|model| &model.entry),
            )
        })();
        drop(exchange);
        let ejected = env.volume.eject(device);
        publication.map_err(not_ready)?;
        ejected.map_err(|_| {
            "The drive was verified, but safe eject failed. No ready drive was recorded."
                .to_string()
        })?;
        // The one hand-off to key escrow; creation itself keeps no passphrase.
        let handle = drive_handle(&current.plan)?;
        env.sink.hand_over(&create.passphrase, &handle)?;
        let installed = ais_host_core::update::InstalledImage::new(
            &current.image,
            current
                .plan
                .identity()
                .ok_or("Missing drive identity.")?
                .clone(),
            current.plan.device(),
        );
        env.sink.remember_image(&handle, &installed, "created")
    }
}

fn perform_update(
    current: PendingConfirmation,
    typed: String,
    remaining: std::time::Duration,
    env: &mut WriteEnv<'_>,
) -> Result<(), String> {
    let previous = current
        .installed
        .as_ref()
        .ok_or("The installed release is unknown.")?;
    let passphrase = &current
        .create
        .as_ref()
        .ok_or("Enter the existing drive passphrase.")?
        .passphrase;
    let handle = drive_handle(&current.plan)?;
    let request = helper_request(&current, typed, remaining)?;
    let sources = current
        .sources
        .as_ref()
        .ok_or("The verified image sources are unavailable.")?;
    let prepared = current
        .update
        .as_ref()
        .ok_or("The update journal is unavailable.")?;
    prepared.journal.check_image(&current.image)?;
    if prepared.journal.previous() != previous {
        return Err("The installed release changed during preparation.".into());
    }
    let exchange = env.volume.mount(&current.plan)?;
    let publication = (|| {
        let sealed = match &prepared.existing {
            Some(sealed) => {
                sealed.check_current(&exchange)?;
                sealed.clone()
            }
            None => ais_host_core::update_journal::SealedJournal::publish(
                &exchange,
                &prepared.journal,
                passphrase.expose(),
            )?,
        };
        env.sink.remember_image(&handle, previous, "updating")?;
        Ok::<_, String>(sealed)
    })();
    drop(exchange);
    // The privileged writer requires exclusive access to an unmounted disk.
    let unmounted = env.volume.unmount(current.plan.device());
    let sealed = publication?;
    unmounted?;
    env.launcher.launch(request, sources).map_err(|_| "The image update did not finish. Reconnect this drive and choose Finish update. Boot and base may be incomplete; encrypted storage is preserved.".to_string())?;
    let installed = ais_host_core::update::InstalledImage::new(
        &current.image,
        previous.identity.clone(),
        current.plan.device(),
    );
    let device = current.plan.device();
    let exchange = env.volume.mount(&current.plan).map_err(|_| {
        "The image was written and read back, but the update journal could not be reopened. Reconnect and choose Finish update."
            .to_string()
    })?;
    let completion = (|| {
        sealed.check_current(&exchange)?;
        // If removal is interrupted, the journal retains the previous release
        // and permits re-verifying the same target after this registry update.
        env.sink
            .remember_image(&handle, &installed, "writtenAwaitingBoot")?;
        sealed.finish(&exchange)
    })();
    drop(exchange);
    let ejected = env.volume.eject(device);
    completion?;
    ejected
        .map_err(|_| "The image was written and read back, but safe eject failed.".to_string())?;
    Ok(())
}

/// Everything `begin_write` needs from the operating system, so the same
/// transaction runs against real hardware or against a file and a directory.
struct WriteEnv<'a> {
    support: ais_host_core::device::WriteSupport,
    observe: &'a dyn Fn(
        &ais_host_core::device::DeviceObservation,
    ) -> Result<ais_host_core::device::DeviceObservation, String>,
    launcher: &'a dyn HelperLauncher,
    volume: &'a dyn ExchangeVolume,
    adapter: &'a mut dyn ais_host_core::flow_adapter::HostAdapter,
    sink: &'a dyn ais_host_core::create::PassphraseSink,
}

/// Opens the verified exchange partition as a retained directory, unmounts it
/// before raw writes and ejects the drive after completion.
trait ExchangeVolume {
    fn mount(
        &self,
        plan: &ais_host_core::device::WritePlan,
    ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
        self.mount_parts(
            plan.device(),
            plan.exchange_range()
                .ok_or("The exchange range is unavailable.")?,
            plan.identity()
                .ok_or("The drive identity is unavailable.")?,
        )
    }
    fn mount_parts(
        &self,
        device: &ais_host_core::device::DeviceObservation,
        range: ais_host_core::device::ByteRange,
        identity: &ais_host_core::drive_identity::DriveIdentity,
    ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String>;
    fn unmount(&self, device: &ais_host_core::device::DeviceObservation) -> Result<(), String>;
    fn eject(&self, device: &ais_host_core::device::DeviceObservation) -> Result<(), String>;
}

/// A registry-safe handle for the physical drive: a digest of its identity
/// fields, so it never exposes a serial or device node.
fn drive_handle(plan: &ais_host_core::device::WritePlan) -> Result<String, String> {
    let identity = plan
        .identity()
        .ok_or("The drive identity is unavailable.")?;
    Ok(identity.record_handle(
        plan.device().serial.as_deref(),
        plan.device().model.as_deref(),
    ))
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
        installed_image: pending.installed.clone(),
        drive_identity: pending
            .plan
            .identity()
            .ok_or("The drive identity is unavailable.")?
            .clone(),
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

#[cfg(target_os = "macos")]
fn deadline_boot_ns(remaining: std::time::Duration) -> Result<u64, String> {
    let now = ais_host_helper::protocol::macos_transport::boottime_ns()
        .map_err(|_| "The boot clock is unavailable.")?;
    let remaining = u64::try_from(remaining.as_nanos()).map_err(|_| "Invalid expiry.")?;
    Ok(now + remaining)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
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

/// The installed per-OS helper. Linux and macOS have authenticated transports.
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

    #[cfg(target_os = "macos")]
    fn launch(
        &self,
        request: ais_host_helper::protocol::Request,
        sources: &[std::fs::File; 3],
    ) -> Result<(), String> {
        let uid = ais_host_helper::protocol::macos_transport::current_uid();
        ais_host_helper::protocol::macos_transport::run_session(
            uid,
            [&sources[0], &sources[1], &sources[2]],
            request,
        )
        .map_err(|error| error.to_string())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn launch(
        &self,
        _request: ais_host_helper::protocol::Request,
        _sources: &[std::fs::File; 3],
    ) -> Result<(), String> {
        Err(ais_host_helper::platform::unavailable_reason().to_string())
    }
}

/// Writes are offered only when the root-owned helper package verifies and the
/// bundled production release key decodes.
fn native_write_support() -> ais_host_core::device::WriteSupport {
    let key_present = ais_host_core::release::ImageVerifier::bundled().is_ok();
    #[cfg(target_os = "linux")]
    let helper = ais_host_helper::protocol::linux_transport::helper_installed();
    #[cfg(target_os = "macos")]
    let helper = ais_host_helper::protocol::macos_transport::helper_installed();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let helper = false;
    let missing_helper = if cfg!(target_os = "macos") {
        "Writing needs the signed, notarised application with its bundled helper; this build is unsigned or a development build."
    } else {
        "The ais host helper package is not installed or does not verify."
    };
    let (enabled, reason) = match (key_present, helper) {
        (true, true) => (true, "Ready."),
        (false, _) => (
            false,
            "The production image signing key is not bundled in this build.",
        ),
        (_, false) => (false, missing_helper),
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

#[cfg(target_os = "macos")]
fn observe_native(
    approved: &ais_host_core::device::DeviceObservation,
) -> Result<ais_host_core::device::DeviceObservation, String> {
    ais_host_helper::platform::observe_macos_unprivileged(approved)
        .map_err(|_| "The selected device is unavailable.".to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
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

#[cfg(target_os = "macos")]
fn preview_native(identity: &str) -> Result<ais_host_core::device::DeviceObservation, String> {
    ais_host_helper::protocol::macos_transport::preview_observation(identity)
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn preview_native(_identity: &str) -> Result<ais_host_core::device::DeviceObservation, String> {
    Err(ais_host_helper::platform::unavailable_reason().to_string())
}

const RELEASE_LISTING: &str =
    "https://api.github.com/repos/DynacomSolutions/AiSwitcher/releases?per_page=30";

/// Takes only the preview identifier; the plan, ticket and image stay native.
#[tauri::command]
async fn start_write(preview_id: String, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ConfirmationSession>();
        // A drive is never written without a registry to record it in.
        let escrow = app
            .try_state::<escrow_commands::EscrowCommandState>()
            .ok_or("The local drive registry is unavailable.")?;
        let executable = std::env::current_exe()
            .map_err(|_| "The bundled host adapter could not be located.")?;
        let adapter_path = executable
            .parent()
            .ok_or("The application directory is unavailable.")?
            .join(if cfg!(target_os = "windows") {
                "ais-host-adapter.exe"
            } else {
                "ais-host-adapter"
            });
        if !adapter_path.is_file() {
            return Err("The bundled host adapter is missing.".to_string());
        }
        let mut adapter = ais_host_core::local_adapter::LocalHostAdapter::with_program(
            adapter_path.to_string_lossy(),
        );
        state.begin_write(
            &preview_id,
            Instant::now(),
            &mut WriteEnv {
                support: native_write_support(),
                observe: &observe_native,
                launcher: &NativeHelper,
                volume: &UdisksVolume,
                adapter: &mut adapter,
                sink: &escrow.sink(),
            },
        )
    })
    .await
    .map_err(|_| "The write could not be started.".to_string())?
}

/// Mounts and ejects the exchange partition (partition 4) through udisks,
/// which authorises removable drives for the active user without elevation.
struct UdisksVolume;

#[cfg(target_os = "linux")]
impl UdisksVolume {
    fn node(device: &ais_host_core::device::DeviceObservation) -> Result<(String, String), String> {
        ais_host_helper::platform::verify_linux_connection(device)
            .map_err(|_| "The drive connection changed.".to_string())?;
        let disk = ais_host_helper::platform::linux_kernel_name(&device.os_identity)
            .map_err(|_| "The drive is unavailable.".to_string())?;
        let node = ais_host_helper::platform::linux_partition_node(&disk, 4);
        Ok((disk, node))
    }

    fn run(arguments: &[&str]) -> Result<String, String> {
        use std::{io::Read, process::Stdio, time::Duration};
        let mut command = std::process::Command::new("/usr/bin/udisksctl");
        command
            .env("LC_ALL", "C")
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if arguments.first() != Some(&"info") {
            command.arg("--no-user-interaction");
        }
        let mut child = command
            .spawn()
            .map_err(|_| "udisksctl is unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or("udisksctl output is unavailable.")?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let result = stdout
                .take(64 * 1024 + 1)
                .read_to_end(&mut output)
                .map(|_| output);
            let _ = send.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => return Err("udisksctl refused the request.".into()),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("udisksctl did not complete.".into());
                }
            }
        }
        let output = receive
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| "udisksctl output is unavailable.")?
            .map_err(|_| "udisksctl output is unreadable.")?;
        if output.len() > 64 * 1024 {
            return Err("udisksctl output exceeds its size limit.".into());
        }
        String::from_utf8(output).map_err(|_| "udisksctl returned invalid text.".to_string())
    }

    /// Derive the mounted directory from the kernel, not command output.
    fn mount_point(mountinfo: &str, major_minor: &str) -> Result<std::path::PathBuf, String> {
        let mut found = None;
        for line in mountinfo.lines() {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.get(2) != Some(&major_minor) {
                continue;
            }
            let separator = fields
                .iter()
                .position(|field| *field == "-")
                .ok_or("The exchange mount is invalid.")?;
            if fields.get(3) != Some(&"/")
                || fields.get(separator + 1) != Some(&"exfat")
                || !fields
                    .get(5)
                    .is_some_and(|options| options.split(',').any(|option| option == "rw"))
                || found.is_some()
            {
                return Err("The exchange mount is ambiguous or not writable exFAT.".into());
            }
            let path = fields
                .get(4)
                .ok_or("The exchange mount is invalid.")?
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\");
            let path = std::path::PathBuf::from(path);
            if !path.is_absolute() || path.parent().is_none() {
                return Err("The exchange mount point is invalid.".into());
            }
            found = Some(path);
        }
        found.ok_or("The exchange mount point is unavailable.".into())
    }
}

#[cfg(target_os = "linux")]
impl ExchangeVolume for UdisksVolume {
    fn mount_parts(
        &self,
        device: &ais_host_core::device::DeviceObservation,
        range: ais_host_core::device::ByteRange,
        identity: &ais_host_core::drive_identity::DriveIdentity,
    ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let (_, node) = Self::node(device)?;
        // The kernel needs a moment to publish the re-read partition table.
        for _ in 0..75 {
            if std::path::Path::new(&node).exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Self::node(device)?;
        let name = std::path::Path::new(&node)
            .file_name()
            .ok_or("Invalid partition name.")?;
        let sysfs = std::path::Path::new("/sys/class/block").join(name);
        let field = |key: &str| -> Result<u64, String> {
            std::fs::read_to_string(sysfs.join(key))
                .map_err(|_| "The exchange layout is unavailable.")?
                .trim()
                .parse::<u64>()
                .map_err(|_| "The exchange layout is invalid.".into())
        };
        if field("start")? != range.start / 512 || field("size")? != range.length / 512 {
            return Err("The exchange layout changed.".into());
        }
        let info = Self::run(&["info", "-b", &node])?;
        let labelled = info.lines().any(|line| {
            line.split_once(':')
                .is_some_and(|(key, value)| key.trim() == "IdLabel" && value.trim() == "AISX")
        });
        let exfat = info.lines().any(|line| {
            line.split_once(':')
                .is_some_and(|(key, value)| key.trim() == "IdType" && value.trim() == "exfat")
        });
        if !labelled || !exfat {
            return Err("The exchange partition is not an AISX exFAT volume.".to_string());
        }
        Self::run(&[
            "mount",
            "-b",
            &node,
            "-t",
            "exfat",
            "-o",
            "nosuid,nodev,noexec",
        ])?;
        let retained = (|| {
            Self::node(device)?;
            let major_minor = std::fs::read_to_string(sysfs.join("dev"))
                .map_err(|_| "The exchange identity is unavailable.")?;
            let mountinfo = std::fs::read_to_string("/proc/self/mountinfo")
                .map_err(|_| "The exchange mount point is unavailable.")?;
            let path = Self::mount_point(&mountinfo, major_minor.trim())?;
            let partition =
                std::fs::metadata(&node).map_err(|_| "The exchange device is unavailable.")?;
            let by_uuid =
                std::fs::metadata(format!("/dev/disk/by-partuuid/{}", identity.partitions[3]))
                    .map_err(|_| "The exchange partition identity is unavailable.")?;
            if !partition.file_type().is_block_device()
                || !by_uuid.file_type().is_block_device()
                || by_uuid.rdev() != partition.rdev()
                || major_minor.trim()
                    != format!(
                        "{}:{}",
                        libc::major(partition.rdev()),
                        libc::minor(partition.rdev())
                    )
            {
                return Err("The exchange partition identity changed.".into());
            }
            let root =
                ais_host_core::exchange_root::ExchangeRoot::open_verified(&path, partition.rdev())?;
            Self::node(device)?;
            Ok(root)
        })();
        if retained.is_err() {
            // Release only the mount we just made, and only while this exact
            // device connection still matches. Never leave a failed inspection
            // mounted and therefore hidden from the next eligible-drive scan.
            let _ = self.unmount(device);
        }
        retained
    }

    fn unmount(&self, device: &ais_host_core::device::DeviceObservation) -> Result<(), String> {
        let (_, node) = Self::node(device)?;
        Self::run(&["unmount", "-b", &node])?;
        Self::node(device)?;
        Ok(())
    }

    fn eject(&self, device: &ais_host_core::device::DeviceObservation) -> Result<(), String> {
        let (disk, _) = Self::node(device)?;
        self.unmount(device)?;
        Self::node(device)?;
        Self::run(&["power-off", "-b", &format!("/dev/{disk}")]).map(|_| ())
    }
}

#[cfg(target_os = "macos")]
impl UdisksVolume {
    fn disk(device: &ais_host_core::device::DeviceObservation) -> Result<String, String> {
        ais_host_helper::platform::verify_macos_connection(device)
            .map_err(|_| "The drive connection changed.".to_string())?;
        ais_host_helper::platform::macos_disk_identifier(&device.os_identity)
            .map(str::to_owned)
            .map_err(|_| "The drive is unavailable.".to_string())
    }
}

// The name is historical: on macOS the same seam is served by diskutil, which
// authorises external media for the active user without elevation.
#[cfg(target_os = "macos")]
impl ExchangeVolume for UdisksVolume {
    fn mount_parts(
        &self,
        device: &ais_host_core::device::DeviceObservation,
        range: ais_host_core::device::ByteRange,
        identity: &ais_host_core::drive_identity::DriveIdentity,
    ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
        let disk = Self::disk(device)?;
        let (node, path) = ais_host_helper::platform::mount_macos_exchange(
            &disk,
            range.length,
            range.start,
            &identity.partitions[3],
        )
        .map_err(|_| "The exchange partition could not be mounted.".to_string())?;
        let retained = Self::disk(device)
            .and_then(|_| ais_host_core::exchange_root::ExchangeRoot::open_verified(&path, &node));
        if retained.is_err() {
            // Never leave a failed inspection mounted and hidden from the
            // next eligible-drive scan.
            let _ = self.unmount(device);
        }
        retained
    }

    fn unmount(&self, device: &ais_host_core::device::DeviceObservation) -> Result<(), String> {
        let disk = Self::disk(device)?;
        ais_host_helper::platform::unmount_macos_slice(
            &ais_host_helper::platform::macos_partition_node(&disk, 4),
        )
        .map_err(|_| "The exchange partition could not be unmounted.".to_string())?;
        Self::disk(device).map(|_| ())
    }

    fn eject(&self, device: &ais_host_core::device::DeviceObservation) -> Result<(), String> {
        let disk = Self::disk(device)?;
        self.unmount(device)?;
        ais_host_helper::platform::eject_macos_disk(&disk)
            .map_err(|_| "The drive could not be ejected.".to_string())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl ExchangeVolume for UdisksVolume {
    fn mount_parts(
        &self,
        _device: &ais_host_core::device::DeviceObservation,
        _range: ais_host_core::device::ByteRange,
        _identity: &ais_host_core::drive_identity::DriveIdentity,
    ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
        Err("This operating system cannot open the exchange partition yet.".to_string())
    }

    fn unmount(&self, _device: &ais_host_core::device::DeviceObservation) -> Result<(), String> {
        Err("This operating system cannot unmount the exchange partition yet.".to_string())
    }

    fn eject(&self, _device: &ais_host_core::device::DeviceObservation) -> Result<(), String> {
        Err("This operating system cannot eject the drive yet.".to_string())
    }
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
        let plan = ais_host_core::device::WritePlan::create_drive(&image, device)
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
            create: None,
            installed: None,
            update: None,
        })
    }

    #[allow(dead_code)] // called by native discovery, which is not wired yet
    fn view(&self) -> WritePreview {
        WritePreview {
            preview_id: self.preview_id.clone(),
            operation: self.plan.operation(),
            display_identifier: self.plan.device().display_identifier.clone(),
            model: self.plan.device().model.clone(),
            serial: self.plan.device().serial.clone(),
            connection_identity: self.plan.device().connection_identity.clone(),
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
mod create_tests;

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

    pub(super) fn support(enabled: bool) -> ais_host_core::device::WriteSupport {
        ais_host_core::device::WriteSupport {
            enabled,
            reason: "SYNTHETIC_FIXTURE disabled",
        }
    }

    fn sources() -> [std::fs::File; 3] {
        let open = || {
            ais_host_core::file_test::fresh_file(&std::env::temp_dir(), "source-SYNTHETIC-FIXTURE")
                .unwrap()
                .1
        };
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

    struct CountingSink;

    impl ais_host_core::create::PassphraseSink for CountingSink {
        fn hand_over(
            &self,
            passphrase: &ais_host_core::create::Passphrase,
            _drive_id: &str,
        ) -> Result<(), String> {
            assert_eq!(passphrase.expose(), "SYNTHETIC_FIXTURE_12");
            HANDED.with(|count| count.set(count.get() + 1));
            Ok(())
        }
    }

    thread_local! {
        static HANDED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }

    fn handed_over() -> u32 {
        HANDED.with(std::cell::Cell::get)
    }

    pub(super) fn stored_create() -> super::StoredCreate {
        super::StoredCreate {
            model: None,
            options: ais_host_core::create::CreateOptions {
                model_id: None,
                licence_accepted: false,
            },
            passphrase: ais_host_core::create::Passphrase::new(
                "SYNTHETIC_FIXTURE_12".into(),
                "SYNTHETIC_FIXTURE_12",
            )
            .unwrap(),
        }
    }

    /// A directory standing in for the mounted exchange partition.
    struct DirectoryVolume {
        directory: std::path::PathBuf,
        ejected: std::cell::Cell<u32>,
    }

    impl super::ExchangeVolume for DirectoryVolume {
        // Confirmation-only fixtures deliberately have no partition table.
        fn mount(
            &self,
            _plan: &WritePlan,
        ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
            ais_host_core::exchange_root::ExchangeRoot::test_directory(&self.directory)
        }

        fn mount_parts(
            &self,
            _device: &DeviceObservation,
            _range: ais_host_core::device::ByteRange,
            _identity: &ais_host_core::drive_identity::DriveIdentity,
        ) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
            ais_host_core::exchange_root::ExchangeRoot::test_directory(&self.directory)
        }
        fn unmount(&self, _device: &DeviceObservation) -> Result<(), String> {
            Ok(())
        }
        fn eject(&self, _device: &DeviceObservation) -> Result<(), String> {
            self.ejected.set(self.ejected.get() + 1);
            Ok(())
        }
    }

    pub(super) struct FakeAdapter;

    impl ais_host_core::flow_adapter::HostAdapter for FakeAdapter {
        fn export_snapshot(
            &mut self,
            _target: &ais_host_core::flow_adapter::HostTarget,
        ) -> Result<Vec<u8>, String> {
            use ais_host_core::contract::{
                BundleEntry, BundleKind, BundleManifest, PathClass, sha256_hex,
            };
            let bytes = b"{\"theme\":\"SYNTHETIC_FIXTURE\"}".to_vec();
            let manifest = BundleManifest {
                version: 1,
                seq: 7,
                created_at: "2026-10-19T00:00:00Z".into(),
                kind: BundleKind::Inbox,
                entries: vec![BundleEntry {
                    path: ".claude/settings.json".into(),
                    class: PathClass::ConfigSettings,
                    sha256: sha256_hex(&bytes),
                    size: bytes.len() as u64,
                }],
                last_inbox_seq: None,
                truncated: None,
                skipped_symlinks: None,
            };
            let files =
                std::collections::BTreeMap::from([(".claude/settings.json".to_string(), bytes)]);
            ais_host_core::bundle::write_bundle_tar(&manifest, &files)
        }
        fn import_logs(
            &mut self,
            _target: &ais_host_core::flow_adapter::HostTarget,
            _tar: &[u8],
        ) -> Result<ais_host_core::flow_adapter::ImportSummary, String> {
            Err("unused".into())
        }
    }

    pub(super) fn exchange_directory(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ais-app-exchange-{tag}-{}",
            fresh_preview_id().unwrap()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn launch_with(
        session: &ConfirmationSession,
        preview_id: &str,
        device: &DeviceObservation,
        now: Instant,
        enabled: bool,
        launcher: &dyn HelperLauncher,
    ) -> Result<(), String> {
        let directory = exchange_directory("unit");
        let volume = DirectoryVolume {
            directory: directory.clone(),
            ejected: std::cell::Cell::new(0),
        };
        let result = session.begin_write(
            preview_id,
            now,
            &mut super::WriteEnv {
                support: support(enabled),
                observe: &|_| Ok(device.clone()),
                launcher,
                volume: &volume,
                adapter: &mut FakeAdapter,
                sink: &CountingSink,
            },
        );
        let _ = std::fs::remove_dir_all(&directory);
        result
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
            create: Some(stored_create()),
            installed: None,
            update: None,
        }
    }

    fn fixture(preview_id: &str) -> (PendingConfirmation, DeviceObservation) {
        let target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
        let device = target.observe().unwrap();
        (pending_for(device.clone(), preview_id), device)
    }

    pub(super) fn session_with_fixture() -> (ConfirmationSession, DeviceObservation, String) {
        let (pending, device) = fixture("PREVIEW_SYNTHETIC_FIXTURE_1");
        let preview_id = pending.preview_id.clone();
        let session = ConfirmationSession::default();
        session.state.lock().unwrap().pending = Some(pending);
        (session, device, preview_id)
    }

    #[test]
    fn journal_inspection_cannot_overlap_a_write() {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        let inspection = session.lock_media().unwrap();
        let recorder = Recorder::default();
        assert!(
            launch_with(&session, &preview_id, &device, now, true, &recorder)
                .unwrap_err()
                .contains("already in progress")
        );
        assert!(recorder.0.borrow().is_empty());
        drop(inspection);
        assert!(session.lock_media().is_ok());
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
        assert_eq!(handed_over(), 0);
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
        assert_eq!(handed_over(), 1);
        assert!(launch_with(&session, &preview_id, &device, now, true, &launcher).is_err());
        assert_eq!(handed_over(), 1);
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
