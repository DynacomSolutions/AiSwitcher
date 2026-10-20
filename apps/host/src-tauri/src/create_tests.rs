//! Create orchestration with a signed fixture, regular disk file and directory
//! mount seam. No device nodes, native credentials or real source homes.
use super::{
    ConfirmationSession, DeviceReviewDetails, ExchangeVolume, HelperLauncher, WriteEnv,
    confirmation_tests::{
        FakeAdapter, exchange_directory, session_with_fixture, stored_create, support,
    },
};
use ais_host_core::{
    device::{DeviceObservation, WritePlan, WriteTarget},
    file_test::{FileTarget, SyntheticRelease, fresh_file},
    flow_adapter::{HostAdapter, HostTarget, ImportSummary},
    registry::{FileRegistry, RegistryStorage},
    release::{DownloadedImage, ImageVerifier, PublishedRelease, hex, sha256},
};
use std::{
    cell::{Cell, RefCell},
    fs,
    io::{Read, Seek, Write},
    path::PathBuf,
    time::Instant,
};

struct Volume {
    directory: PathBuf,
    fail_mount: bool,
    fail_eject: bool,
    ejected: Cell<usize>,
}

impl ExchangeVolume for Volume {
    fn mount(&self, _: &WritePlan) -> Result<ais_host_core::exchange_root::ExchangeRoot, String> {
        if self.fail_mount {
            Err("SYNTHETIC_FIXTURE mount failure".into())
        } else {
            ais_host_core::exchange_root::ExchangeRoot::test_directory(&self.directory)
        }
    }
    fn eject(&self, _: &DeviceObservation) -> Result<(), String> {
        self.ejected.set(self.ejected.get() + 1);
        if self.fail_eject {
            Err("SYNTHETIC_FIXTURE eject failure".into())
        } else {
            Ok(())
        }
    }
}

struct FileHelper {
    target: RefCell<FileTarget>,
    public_key: String,
    calls: Cell<usize>,
}

impl HelperLauncher for FileHelper {
    fn launch(
        &self,
        request: ais_host_helper::protocol::Request,
        sources: &[fs::File; 3],
    ) -> Result<(), String> {
        use ais_host_helper::{exchange::PreparedExchange, service::create_confirmed};
        self.calls.set(self.calls.get() + 1);
        let encoded = serde_json::to_string(&request).unwrap();
        assert!(!encoded.contains("SYNTHETIC_FIXTURE_12"));
        assert!(!encoded.contains(".claude/settings.json"));
        assert!(
            sources
                .iter()
                .all(|file| file.metadata().unwrap().is_file())
        );
        let selection = ais_host_core::release::select_release(&[request.release]).unwrap();
        let read = |file: &fs::File| {
            let mut file = file.try_clone().unwrap();
            file.rewind().unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            bytes
        };
        let download = DownloadedImage {
            source: sources[0].try_clone().unwrap(),
            image_identity: selection.image().clone(),
            sums_identity: selection.sums().clone(),
            signature_identity: selection.signature().clone(),
            sums: read(&sources[1]),
            signature: read(&sources[2]),
        };
        let mut image = ImageVerifier::synthetic_live_layout(&self.public_key)
            .unwrap()
            .verify(&selection, download)
            .unwrap();
        let mut target = self.target.borrow_mut();
        if let Some(installed) = request.installed_image.as_ref() {
            let snapshot = ais_host_core::update::DriveSnapshot::read(
                target.observe().unwrap(),
                |offset, bytes| target.read_at(offset, bytes),
            )
            .unwrap();
            let plan = WritePlan::update_drive(&image, &snapshot, installed).unwrap();
            assert_eq!(request.plan_digest, hex(&plan.digest()));
            return ais_host_helper::service::write_confirmed(
                &mut *target,
                request.confirmation_deadline_boot_ns,
                &mut image,
                &plan,
                &request.typed_confirmation,
            )
            .map(|_| ())
            .map_err(str::to_owned);
        }
        let plan = WritePlan::create_drive_with_identity(
            &image,
            target.observe().unwrap(),
            request.drive_identity,
        )
        .unwrap();
        assert_eq!(request.plan_digest, hex(&plan.digest()));
        let directory = std::env::var_os("AIS_HOST_TEST_EXFAT_TOOLS").map(PathBuf::from);
        let tool = |name: &str| {
            directory
                .as_ref()
                .map_or_else(|| PathBuf::from(name), |path| path.join(name))
        };
        let mut exchange =
            PreparedExchange::fixture(&plan, &tool("mkfs.exfat"), &tool("fsck.exfat"))
                .expect("file smoke requires exfatprogs on PATH or AIS_HOST_TEST_EXFAT_TOOLS");
        create_confirmed(
            &mut *target,
            request.confirmation_deadline_boot_ns,
            &mut image,
            &plan,
            &request.typed_confirmation,
            &mut exchange,
        )
        .map_err(str::to_owned)?;
        plan.verify_created_target(&mut *target).unwrap();
        let range = plan.exchange_range().unwrap();
        assert!(plan.remaining_bytes() >= ais_host_core::create::PERSIST_RESERVE_BYTES);
        let mut boot = [0; 512];
        target.read_at(range.start, &mut boot).unwrap();
        assert_eq!(&boot[3..11], b"EXFAT   ");
        assert_eq!(
            u64::from_le_bytes(boot[64..72].try_into().unwrap()),
            range.start / 512
        );
        // Persist has a zeroed header area and no LUKS header until first boot.
        target
            .read_at(range.start + range.length, &mut boot)
            .unwrap();
        assert!(boot.iter().all(|byte| *byte == 0));
        target.read_at(1024 + 4 * 128, &mut boot[..128]).unwrap();
        assert!(boot[..16].iter().any(|byte| *byte != 0));
        assert!(boot[16..32].iter().any(|byte| *byte != 0));
        Ok(())
    }
}

fn registry() -> (PathBuf, super::escrow_commands::EscrowCommandState) {
    use std::os::unix::fs::PermissionsExt;
    let path = exchange_directory("registry");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let state = super::escrow_commands::EscrowCommandState::new(path.clone()).unwrap();
    (path, state)
}

fn volume() -> Volume {
    Volume {
        directory: exchange_directory("volume"),
        fail_mount: false,
        fail_eject: false,
        ejected: Cell::new(0),
    }
}

fn create_smoke(with_model: bool) {
    let dir = std::env::temp_dir();
    let target = FileTarget::create_sparse(&dir, 3 * 1024 * 1024 * 1024).unwrap();
    let device = target.observe().unwrap();
    let fixture = SyntheticRelease::new(ais_host_core::layout::synthetic_sfdisk_contract_fixture());
    let (_, image) = fixture.verify_live_layout(&dir).unwrap();
    let sources = [&fixture.compressed, &fixture.sums, &fixture.signature].map(|body| {
        let (_, mut file) = fresh_file(&dir, "source-SYNTHETIC-FIXTURE").unwrap();
        file.write_all(body).unwrap();
        file.rewind().unwrap();
        file
    });
    let release = PublishedRelease {
        id: 1,
        tag: fixture.selection.tag().into(),
        published_at: 1,
        draft: false,
        prerelease: false,
        assets: vec![
            fixture.selection.image().clone(),
            fixture.selection.sums().clone(),
            fixture.selection.signature().clone(),
        ],
    };
    let helper = FileHelper {
        target: RefCell::new(target),
        public_key: fixture.public_key,
        calls: Cell::new(0),
    };
    let mut create = stored_create();
    if with_model {
        let body = b"SYNTHETIC_FIXTURE model bytes";
        let (path, mut file) = fresh_file(&dir, "model-SYNTHETIC-FIXTURE").unwrap();
        file.write_all(body).unwrap();
        let mut entry =
            ais_host_core::create::Catalogue::parse(ais_host_core::create::BUNDLED_CATALOGUE)
                .unwrap()
                .models
                .remove(0);
        entry.id = "SYNTHETIC_FIXTURE_MODEL".into();
        entry.file = "synthetic.gguf".into();
        entry.size_bytes = body.len() as u64;
        entry.sha256 = hex(&sha256(body));
        create.options.model_id = Some(entry.id.clone());
        create.options.licence_accepted = true;
        create.model = Some(ais_host_core::model::VerifiedModel { entry, file, path });
    }
    let session = ConfirmationSession::default();
    session.retain_listed(vec![device.clone()]);
    session.set_create(create).unwrap();
    let preparation = session.begin_preview(&device.os_identity).unwrap();
    let preview = session
        .install_native_preview(
            image,
            release,
            device.clone(),
            DeviceReviewDetails::default(),
            sources,
            preparation,
        )
        .unwrap();
    let drive_handle =
        super::drive_handle(&session.state.lock().unwrap().pending.as_ref().unwrap().plan).unwrap();
    let now = Instant::now();
    session
        .confirm(&preview.preview_id, &device.display_identifier, now)
        .unwrap();
    let volume = volume();
    let (directory, escrow) = registry();
    session
        .begin_write(
            &preview.preview_id,
            now,
            &mut WriteEnv {
                support: support(true),
                observe: &|_| Ok(device.clone()),
                launcher: &helper,
                volume: &volume,
                adapter: &mut FakeAdapter,
                sink: &escrow.sink(),
            },
        )
        .unwrap();
    assert_eq!(helper.calls.get(), 1);
    assert_eq!(volume.ejected.get(), 1);
    let bundle = ais_host_core::bundle::read_bundle_file(
        &volume.directory.join("inbox/bundle-1.age"),
        "SYNTHETIC_FIXTURE_12",
        ais_host_core::contract::BundleKind::Inbox,
    )
    .unwrap();
    assert_eq!(bundle.manifest.seq, 1);
    assert!(bundle.files.contains_key(".claude/settings.json"));
    assert_eq!(volume.directory.join("models").exists(), with_model);
    if with_model {
        assert_eq!(
            fs::read(volume.directory.join("models/synthetic.gguf")).unwrap(),
            b"SYNTHETIC_FIXTURE model bytes"
        );
    }
    let data = FileRegistry::open(&directory).unwrap().load().unwrap();
    let record = data.record(&drive_handle).unwrap();
    assert!(record.created_here());
    assert!(record.item().is_none());
    assert!(
        session
            .begin_write(
                &preview.preview_id,
                now,
                &mut WriteEnv {
                    support: support(true),
                    observe: &|_| Ok(device.clone()),
                    launcher: &helper,
                    volume: &volume,
                    adapter: &mut FakeAdapter,
                    sink: &escrow.sink(),
                }
            )
            .is_err()
    );
    assert_eq!(helper.calls.get(), 1);
    if !with_model {
        update_smoke(
            helper.target.into_inner().reopen().unwrap(),
            record.installed_image().unwrap().clone(),
            &volume,
            &escrow,
            &directory,
        );
    }
}

fn update_smoke(
    mut target: FileTarget,
    previous: ais_host_core::update::InstalledImage,
    volume: &Volume,
    escrow: &super::escrow_commands::EscrowCommandState,
    registry_directory: &std::path::Path,
) {
    let directory = std::env::temp_dir();
    let snapshot =
        ais_host_core::update::DriveSnapshot::read(target.observe().unwrap(), |offset, bytes| {
            target.read_at(offset, bytes)
        })
        .unwrap();
    let original_inbox = fs::read(volume.directory.join("inbox/bundle-1.age")).unwrap();
    let mut raw = ais_host_core::layout::synthetic_sfdisk_contract_fixture();
    let layout = ais_host_core::layout::LiveImageLayout::parse(&raw).unwrap();
    raw[(layout.partitions[2].first_lba * 512) as usize] = 0x72;
    let fixture = SyntheticRelease::new_version(raw, 2);
    let helper = FileHelper {
        target: RefCell::new(target),
        public_key: fixture.public_key.clone(),
        calls: Cell::new(0),
    };
    let failing = Launcher {
        fail: true,
        calls: Cell::new(0),
    };
    for fail in [true, false] {
        let (_, image) = fixture.verify_live_layout(&directory).unwrap();
        let plan = WritePlan::update_drive(&image, &snapshot, &previous).unwrap();
        let handle = super::drive_handle(&plan).unwrap();
        let sources = [&fixture.compressed, &fixture.sums, &fixture.signature].map(|body| {
            let (_, mut file) = fresh_file(&directory, "update-source-SYNTHETIC-FIXTURE").unwrap();
            file.write_all(body).unwrap();
            file.rewind().unwrap();
            file
        });
        let session = ConfirmationSession::default();
        let preview_id = super::fresh_preview_id().unwrap();
        let pending = super::PendingConfirmation {
            preview_id: preview_id.clone(),
            plan,
            image,
            release: PublishedRelease {
                id: 2,
                published_at: 2,
                tag: fixture.selection.tag().into(),
                draft: false,
                prerelease: false,
                assets: vec![
                    fixture.selection.image().clone(),
                    fixture.selection.sums().clone(),
                    fixture.selection.signature().clone(),
                ],
            },
            details: DeviceReviewDetails::default(),
            ticket: None,
            typed: None,
            sources: Some(sources),
            create: Some(stored_create()),
            installed: Some(previous.clone()),
        };
        session.state.lock().unwrap().pending = Some(pending);
        let now = Instant::now();
        session
            .confirm(&preview_id, &snapshot.observation.display_identifier, now)
            .unwrap();
        let result = session.begin_write(
            &preview_id,
            now,
            &mut WriteEnv {
                support: support(true),
                observe: &|_| Ok(snapshot.observation.clone()),
                launcher: if fail { &failing } else { &helper },
                volume,
                // Updating must never export and replay the host's credentials.
                adapter: &mut Adapter { fail: true },
                sink: &escrow.sink(),
            },
        );
        assert_eq!(result.is_err(), fail, "{result:?}");
        let data = FileRegistry::open(registry_directory)
            .unwrap()
            .load()
            .unwrap();
        let record = data.record(&handle).unwrap();
        assert_eq!(
            record.image_update_status(),
            Some(if fail {
                "updating"
            } else {
                "writtenAwaitingBoot"
            })
        );
        assert_eq!(
            record.installed_image().unwrap().tag,
            if fail { "live-v1.0.0" } else { "live-v2.0.0" }
        );
        if fail {
            assert!(!volume.directory.join("inbox/bundle-2.age").exists());
        } else {
            assert_eq!(record.inbox_issued(), 2);
            let marker = ais_host_core::bundle::read_bundle_file(
                &volume.directory.join("inbox/bundle-2.age"),
                "SYNTHETIC_FIXTURE_12",
                ais_host_core::contract::BundleKind::Inbox,
            )
            .unwrap();
            assert_eq!(marker.files.len(), 1);
            assert!(marker.files.contains_key(".ais/logs/image-updated.jsonl"));
        }
        assert_eq!(
            fs::read(volume.directory.join("inbox/bundle-1.age")).unwrap(),
            original_inbox
        );
        assert!(session.state.lock().unwrap().pending.is_none());
    }
    assert_eq!(failing.calls.get(), 1);
    assert_eq!(helper.calls.get(), 1);
    assert_eq!(volume.ejected.get(), 2);
}

#[test]
fn file_create_smoke_with_model() {
    create_smoke(true);
}
#[test]
fn file_create_and_update_smoke_without_model() {
    create_smoke(false);
}

struct Launcher {
    fail: bool,
    calls: Cell<usize>,
}
impl HelperLauncher for Launcher {
    fn launch(
        &self,
        _: ais_host_helper::protocol::Request,
        _: &[fs::File; 3],
    ) -> Result<(), String> {
        self.calls.set(self.calls.get() + 1);
        if self.fail {
            Err("SYNTHETIC_FIXTURE helper failure".into())
        } else {
            Ok(())
        }
    }
}
struct Adapter {
    fail: bool,
}
impl HostAdapter for Adapter {
    fn export_snapshot(&mut self, target: &HostTarget) -> Result<Vec<u8>, String> {
        if self.fail {
            Err("SYNTHETIC_FIXTURE cancelled source".into())
        } else {
            FakeAdapter.export_snapshot(target)
        }
    }
    fn import_logs(&mut self, _: &HostTarget, _: &[u8]) -> Result<ImportSummary, String> {
        unreachable!()
    }
}

#[test]
fn source_helper_mount_publish_and_eject_failures_never_register_a_drive() {
    for stage in 0..5 {
        let (session, device, preview_id) = session_with_fixture();
        let now = Instant::now();
        session
            .confirm(&preview_id, &device.display_identifier, now)
            .unwrap();
        let launcher = Launcher {
            fail: stage == 1,
            calls: Cell::new(0),
        };
        let mut volume = volume();
        volume.fail_mount = stage == 2;
        volume.fail_eject = stage == 4;
        if stage == 3 {
            fs::write(
                volume.directory.join("inbox"),
                b"SYNTHETIC_FIXTURE obstacle",
            )
            .unwrap();
        }
        let (directory, escrow) = registry();
        let result = session.begin_write(
            &preview_id,
            now,
            &mut WriteEnv {
                support: support(true),
                observe: &|_| Ok(device.clone()),
                launcher: &launcher,
                volume: &volume,
                adapter: &mut Adapter { fail: stage == 0 },
                sink: &escrow.sink(),
            },
        );
        assert!(result.is_err(), "stage {stage}");
        assert_eq!(launcher.calls.get(), usize::from(stage != 0));
        assert_eq!(volume.ejected.get(), usize::from(stage >= 2));
        assert_eq!(
            FileRegistry::open(&directory)
                .unwrap()
                .load()
                .unwrap()
                .records()
                .count(),
            0
        );
        assert!(session.state.lock().unwrap().pending.is_none());
    }
}

#[test]
fn missing_helper_blocks_the_write_step_before_launch() {
    let (session, device, preview_id) = session_with_fixture();
    let now = Instant::now();
    session
        .confirm(&preview_id, &device.display_identifier, now)
        .unwrap();
    let launcher = Launcher {
        fail: false,
        calls: Cell::new(0),
    };
    let volume = volume();
    let (directory, escrow) = registry();
    assert!(
        session
            .begin_write(
                &preview_id,
                now,
                &mut WriteEnv {
                    support: super::native_write_support(),
                    observe: &|_| Ok(device.clone()),
                    launcher: &launcher,
                    volume: &volume,
                    adapter: &mut FakeAdapter,
                    sink: &escrow.sink(),
                }
            )
            .is_err()
    );
    assert_eq!(launcher.calls.get(), 0);
    assert_eq!(
        FileRegistry::open(&directory)
            .unwrap()
            .load()
            .unwrap()
            .records()
            .count(),
        0
    );
}

#[test]
fn exchange_mount_requires_one_writable_exfat_root_for_the_expected_partition() {
    let line = "44 21 8:20 / /media/SYNTHETIC_FIXTURE\\040USB rw,nosuid,nodev,noexec - exfat SYNTHETIC_FIXTURE rw";
    assert_eq!(
        super::UdisksVolume::mount_point(line, "8:20").unwrap(),
        PathBuf::from("/media/SYNTHETIC_FIXTURE USB")
    );
    for invalid in [
        line.replace("8:20", "8:21"),
        line.replace(" exfat ", " ext4 "),
        line.replace("rw,nosuid", "ro,nosuid"),
        line.replace(" / /media", " /subtree /media"),
        format!("{line}\n{line}"),
    ] {
        assert!(super::UdisksVolume::mount_point(&invalid, "8:20").is_err());
    }
}

#[test]
fn preview_preparation_keeps_choices_and_rejects_results_after_refresh_or_edit() {
    for refresh in [true, false] {
        let session = ConfirmationSession::default();
        let dir = std::env::temp_dir();
        let target = FileTarget::create_sparse(&dir, 3 * 1024 * 1024 * 1024).unwrap();
        let device = target.observe().unwrap();
        session.retain_listed(vec![device.clone()]);
        session.set_create(stored_create()).unwrap();
        let preparation = session.begin_preview(&device.os_identity).unwrap();
        assert_eq!(
            preparation.create.passphrase.expose(),
            "SYNTHETIC_FIXTURE_12"
        );
        assert!(session.state.lock().unwrap().create.is_none());
        if refresh {
            session.invalidate();
            assert!(session.begin_preview(&device.os_identity).is_err());
        } else {
            session.set_create(stored_create()).unwrap();
        }
        let fixture =
            SyntheticRelease::new(ais_host_core::layout::synthetic_sfdisk_contract_fixture());
        let (_, image) = fixture.verify_live_layout(&dir).unwrap();
        let release = PublishedRelease {
            id: 1,
            tag: fixture.selection.tag().into(),
            published_at: 1,
            draft: false,
            prerelease: false,
            assets: vec![
                fixture.selection.image().clone(),
                fixture.selection.sums().clone(),
                fixture.selection.signature().clone(),
            ],
        };
        let sources = [&fixture.compressed, &fixture.sums, &fixture.signature].map(|body| {
            let (_, mut file) = fresh_file(&dir, "source-SYNTHETIC-FIXTURE").unwrap();
            file.write_all(body).unwrap();
            file
        });
        assert!(
            session
                .install_native_preview(
                    image,
                    release,
                    target.observe().unwrap(),
                    DeviceReviewDetails::default(),
                    sources,
                    preparation,
                )
                .is_err()
        );
        assert!(session.state.lock().unwrap().pending.is_none());
        if !refresh {
            assert!(session.begin_preview(&device.os_identity).is_ok());
        }
    }
}

#[test]
fn listed_device_replacement_is_rejected_before_installing_confirmation() {
    let target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let listed = target.observe().unwrap();
    for changed_field in ["serial", "model", "size", "connection"] {
        let session = ConfirmationSession::default();
        session.retain_listed(vec![listed.clone()]);
        session.set_create(stored_create()).unwrap();
        let preparation = session.begin_preview(&listed.os_identity).unwrap();
        let mut replacement = listed.clone();
        match changed_field {
            "serial" => replacement.serial = Some("SYNTHETIC_FIXTURE_REPLACEMENT".into()),
            "model" => replacement.model = Some("SYNTHETIC_FIXTURE_REPLACEMENT".into()),
            "size" => replacement.capacity_bytes += 512,
            _ => replacement.connection_identity.push_str("-replacement"),
        }
        let fixture = SyntheticRelease::new(vec![0x53; 512]);
        let (_, image) = fixture.verify(&std::env::temp_dir()).unwrap();
        let release = PublishedRelease {
            id: 1,
            tag: fixture.selection.tag().into(),
            published_at: 1,
            draft: false,
            prerelease: false,
            assets: vec![
                fixture.selection.image().clone(),
                fixture.selection.sums().clone(),
                fixture.selection.signature().clone(),
            ],
        };
        let sources = std::array::from_fn(|_| {
            fresh_file(&std::env::temp_dir(), "observation-SYNTHETIC-FIXTURE")
                .unwrap()
                .1
        });
        assert!(
            session
                .install_native_preview(
                    image,
                    release,
                    replacement,
                    DeviceReviewDetails::default(),
                    sources,
                    preparation
                )
                .unwrap_err()
                .contains("listed drive changed")
        );
        assert!(session.state.lock().unwrap().pending.is_none());
    }
}

#[test]
fn preview_presents_bound_identity_and_drive_record_survives_reconnection() {
    let (session, original, _) = session_with_fixture();
    let mut state = session.state.lock().unwrap();
    let pending = state.pending.as_mut().unwrap();
    let preview = pending.view();
    assert_eq!(preview.serial, original.serial);
    assert_eq!(preview.model, original.model);
    assert_eq!(preview.connection_identity, original.connection_identity);
    let handle = super::drive_handle(&pending.plan).unwrap();
    let identity = pending.plan.identity().unwrap().clone();
    let mut reconnected = original.clone();
    reconnected.os_identity = "SYNTHETIC_FIXTURE_OTHER_NODE".into();
    reconnected.connection_identity = "SYNTHETIC_FIXTURE_NEW_DISKSEQ".into();
    assert!(!original.same_physical_identity(&reconnected));
    assert_eq!(
        handle,
        identity.record_handle(reconnected.serial.as_deref(), reconnected.model.as_deref())
    );
    assert_ne!(
        handle,
        ais_host_core::drive_identity::DriveIdentity::fresh()
            .unwrap()
            .record_handle(reconnected.serial.as_deref(), reconnected.model.as_deref())
    );
}
