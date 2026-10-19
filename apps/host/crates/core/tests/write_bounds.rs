#![cfg(feature = "file-test")]
use ais_host_core::{
    device::{ConfirmationBook, WriteFailure, WritePlan, WriteTarget, write_image},
    file_test::{FileTarget, SyntheticRelease, run_write_safety},
};
use std::{
    io::{Read, Seek},
    time::{Duration, Instant},
};

struct SparseTarget {
    file: std::fs::File,
    observation: ais_host_core::device::DeviceObservation,
}

impl WriteTarget for SparseTarget {
    fn observe(&self) -> std::io::Result<ais_host_core::device::DeviceObservation> {
        let mut file = self.file.try_clone()?;
        let position = file.stream_position()?;
        let mut head = vec![0; ais_host_core::device::TABLE_WINDOW_BYTES];
        let mut tail = vec![0; ais_host_core::device::TABLE_WINDOW_BYTES];
        let read_result = (|| {
            file.seek(std::io::SeekFrom::Start(0))?;
            file.read_exact(&mut head)?;
            file.seek(std::io::SeekFrom::Start(
                self.observation.capacity_bytes - ais_host_core::device::TABLE_WINDOW_BYTES as u64,
            ))?;
            file.read_exact(&mut tail)
        })();
        let restore_result = file.seek(std::io::SeekFrom::Start(position));
        read_result?;
        restore_result?;
        let mut observation = self.observation.clone();
        observation.table_fingerprint = ais_host_core::device::table_fingerprint(&head, &tail)
            .map_err(|_| std::io::Error::other("synthetic table fingerprint"))?;
        Ok(observation)
    }
    fn lock_exclusive(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    fn flush_durable(&mut self) -> std::io::Result<()> {
        self.file.sync_all()
    }
}
impl std::io::Read for SparseTarget {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        std::io::Read::read(&mut self.file, bytes)
    }
}
impl std::io::Write for SparseTarget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        std::io::Write::write(&mut self.file, bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(&mut self.file)
    }
}
impl std::io::Seek for SparseTarget {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        std::io::Seek::seek(&mut self.file, position)
    }
}

#[test]
fn all_refusals_preserve_bytes_and_faults_preserve_outside_sentinels() {
    assert_eq!(run_write_safety(&std::env::temp_dir()).unwrap(), 26);
}

#[test]
fn production_layout_writer_relocates_gpt_and_keeps_out_of_range_sentinel() {
    use ais_host_core::{
        device::{DeviceObservation, TABLE_WINDOW_BYTES, WriteOperation, table_fingerprint},
        file_test::fresh_file,
        layout::{
            GPT_ARRAY_BYTES, GPT_TRAILER_SECTORS, SECTOR_BYTES, synthetic_sfdisk_contract_fixture,
        },
        release::sha256,
    };
    use std::io::{Read, Seek, SeekFrom, Write};

    let raw = synthetic_sfdisk_contract_fixture();
    let fixture = SyntheticRelease::new(raw.clone());
    let (_, mut image) = fixture
        .verify_live_layout(&std::env::temp_dir())
        .expect("signed synthetic B layout");
    let capacity = raw.len() as u64 + 8 * 1024 * 1024;
    let (path, mut file) = fresh_file(&std::env::temp_dir(), "sparse-SYNTHETIC-FIXTURE").unwrap();
    file.set_len(capacity + 512).unwrap();
    file.seek(SeekFrom::Start(capacity)).unwrap();
    file.write_all(&[0xa7; 512]).unwrap();
    file.sync_all().unwrap();
    let observation = DeviceObservation {
        os_identity: "SYNTHETIC_FIXTURE_OS".into(),
        connection_identity: "SYNTHETIC_FIXTURE_CONNECTION".into(),
        display_identifier: "SYNTHETIC_FIXTURE_DISK".into(),
        serial: Some("SYNTHETIC_FIXTURE_SERIAL".into()),
        capacity_bytes: capacity,
        sector_bytes: 512,
        table_fingerprint: table_fingerprint(
            &vec![0; TABLE_WINDOW_BYTES],
            &vec![0; TABLE_WINDOW_BYTES],
        )
        .unwrap(),
        ancestry_fingerprint: sha256(b"SYNTHETIC_FIXTURE_ANCESTRY"),
        mount_fingerprint: sha256(b"SYNTHETIC_FIXTURE_MOUNTS"),
        external_usb: true,
        internal: false,
        system_backing: false,
        ancestry_complete: true,
        writable: true,
    };
    let plan = WritePlan::create_layout(&image, observation.clone()).unwrap();
    assert_eq!(plan.operation(), WriteOperation::CreateLayout);
    let mut target = SparseTarget { file, observation };
    let mut book = ConfirmationBook::default();
    let ticket = book
        .issue(
            &plan,
            &plan.device().display_identifier,
            Instant::now(),
            Duration::from_secs(30),
        )
        .unwrap();
    assert_eq!(
        write_image(&mut target, &mut image, &plan, &mut book, &ticket, || false),
        Ok(plan.ranges().iter().map(|range| range.length).sum())
    );

    let sectors = capacity / SECTOR_BYTES;
    let mut primary = vec![0; TABLE_WINDOW_BYTES];
    target.file.seek(SeekFrom::Start(0)).unwrap();
    target.file.read_exact(&mut primary).unwrap();
    assert_eq!(&primary[..440], &raw[..440]);
    assert_eq!(
        u64::from_le_bytes(primary[512 + 32..512 + 40].try_into().unwrap()),
        sectors - 1
    );
    assert_eq!(
        u64::from_le_bytes(primary[512 + 48..512 + 56].try_into().unwrap()),
        sectors - 34
    );
    assert_eq!(
        u64::from_le_bytes(
            primary[2 * 512 + 128 + 48..2 * 512 + 128 + 56]
                .try_into()
                .unwrap()
        ),
        1 << 2
    );

    let tail_start = (sectors - 34) * SECTOR_BYTES;
    let mut tail = vec![0; TABLE_WINDOW_BYTES];
    target.file.seek(SeekFrom::Start(tail_start)).unwrap();
    target.file.read_exact(&mut tail).unwrap();
    let backup_entries = &tail[512..512 + GPT_ARRAY_BYTES];
    assert_eq!(backup_entries, &primary[1024..1024 + GPT_ARRAY_BYTES]);
    let backup_header = &tail[TABLE_WINDOW_BYTES - 512..];
    assert_eq!(&backup_header[..8], b"EFI PART");
    assert_eq!(
        u64::from_le_bytes(backup_header[24..32].try_into().unwrap()),
        sectors - 1
    );
    assert_eq!(
        u64::from_le_bytes(backup_header[72..80].try_into().unwrap()),
        sectors - GPT_TRAILER_SECTORS
    );
    let mut header_crc = backup_header[..92].to_vec();
    let stored_crc = u32::from_le_bytes(header_crc[16..20].try_into().unwrap());
    header_crc[16..20].fill(0);
    assert_eq!(stored_crc, test_crc32(&header_crc));
    target.file.seek(SeekFrom::Start(capacity)).unwrap();
    let mut sentinel = [0; 512];
    target.file.read_exact(&mut sentinel).unwrap();
    assert_eq!(sentinel, [0xa7; 512]);
    std::fs::remove_file(path).unwrap();
}

fn test_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[test]
fn a_second_app_session_cannot_use_another_sessions_ticket() {
    let fixture = SyntheticRelease::new(vec![0x45; 512]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut first = ConfirmationBook::default();
    let mut second = ConfirmationBook::default();
    let now = Instant::now();
    let ticket = first
        .issue(
            &plan,
            &observation.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap();
    let before = target.read_all().unwrap();
    assert!(matches!(
        write_image(&mut target, &mut image, &plan, &mut second, &ticket, || {
            false
        }),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(target.read_all().unwrap(), before);
}

#[test]
fn target_path_reuse_is_rejected_before_mutation() {
    let fixture = SyntheticRelease::new(vec![0x45; 512]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut book = ConfirmationBook::default();
    let now = Instant::now();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap();
    let before = target.read_all().unwrap();
    let moved = target.path().with_extension("retained");
    std::fs::rename(target.path(), moved).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target.path())
        .unwrap();
    assert!(matches!(
        write_image(&mut target, &mut image, &plan, &mut book, &ticket, || false),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(target.read_all().unwrap(), before);
    assert_eq!(std::fs::metadata(target.path()).unwrap().len(), 0);
}

#[test]
fn ticket_expiring_during_lock_preparation_preserves_target() {
    let fixture = SyntheticRelease::new(vec![0x45; 64 * 1024]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 128 * 1024).unwrap();
    target.delay_lock(Duration::from_millis(30));
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let before = target.read_all().unwrap();
    let mut book = ConfirmationBook::default();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            Instant::now(),
            Duration::from_millis(5),
        )
        .unwrap();
    assert!(matches!(
        write_image(&mut target, &mut image, &plan, &mut book, &ticket, || false),
        Err(WriteFailure::Refused("confirmation"))
    ));
    assert_eq!(target.read_all().unwrap(), before);
}

#[test]
fn mount_change_after_first_chunk_stops_writer_and_preserves_tail() {
    let fixture = SyntheticRelease::new(vec![0x45; 128 * 1024]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 256 * 1024).unwrap();
    target.tamper_mount_after_write();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut book = ConfirmationBook::default();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            Instant::now(),
            Duration::from_secs(10),
        )
        .unwrap();
    assert!(matches!(
        write_image(&mut target, &mut image, &plan, &mut book, &ticket, || false),
        Err(WriteFailure::Incomplete { .. })
    ));
    let after = target.read_all().unwrap();
    assert!(
        after[image.len() as usize..]
            .iter()
            .all(|byte| *byte == 0xa7)
    );
}

#[test]
fn repeated_interrupted_writes_still_observe_cancellation() {
    let fixture = SyntheticRelease::new(vec![0x45; 64 * 1024]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 128 * 1024).unwrap();
    target.interrupt_writes(usize::MAX);
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let before = target.read_all().unwrap();
    let mut book = ConfirmationBook::default();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            Instant::now(),
            Duration::from_secs(10),
        )
        .unwrap();
    let mut checks = 0;
    assert!(matches!(
        write_image(&mut target, &mut image, &plan, &mut book, &ticket, || {
            checks += 1;
            checks >= 8
        }),
        Err(WriteFailure::Refused("cancelled or timed out"))
    ));
    assert_eq!(target.read_all().unwrap(), before);
}

#[cfg(unix)]
#[test]
fn target_symlink_swap_cannot_redirect_the_writer() {
    let fixture = SyntheticRelease::new(vec![0x45; 512]);
    let (_, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
    let mut target = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let mut other = FileTarget::create(&std::env::temp_dir(), 4096).unwrap();
    let observation = target.observe().unwrap();
    let plan = WritePlan::synthetic_image(&image, observation.clone()).unwrap();
    let mut book = ConfirmationBook::default();
    let now = Instant::now();
    let ticket = book
        .issue(
            &plan,
            &observation.display_identifier,
            now,
            Duration::from_secs(10),
        )
        .unwrap();
    let before = target.read_all().unwrap();
    std::fs::rename(target.path(), target.path().with_extension("retained")).unwrap();
    std::os::unix::fs::symlink(other.path(), target.path()).unwrap();
    assert!(matches!(
        write_image(&mut target, &mut image, &plan, &mut book, &ticket, || false),
        Err(WriteFailure::Refused(_))
    ));
    assert_eq!(target.read_all().unwrap(), before);
    assert_eq!(other.read_all().unwrap(), before);
}
