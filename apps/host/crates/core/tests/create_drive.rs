use ais_host_core::create::{
    BUNDLED_CATALOGUE, Catalogue, CreateError, CreateOptions, ModelEntry, PERSIST_RESERVE_BYTES,
    Passphrase, check_capacity,
};

const GIB: u64 = 1024 * 1024 * 1024;

fn catalogue() -> Catalogue {
    Catalogue {
        models: vec![ModelEntry {
            id: "SYNTHETIC_FIXTURE_model".into(),
            name: "Synthetic model".into(),
            quality: "fixture".into(),
            size_bytes: 3 * GIB,
            licence_name: "Synthetic licence".into(),
            licence_text: "SYNTHETIC_FIXTURE licence text".into(),
            revision: "r1".into(),
            sha256: "a".repeat(64),
        }],
    }
}

#[test]
fn declining_a_model_needs_no_catalogue_entry_and_no_model_bytes() {
    let options = CreateOptions {
        model_id: None,
        licence_accepted: false,
    };
    let model = check_capacity(
        &options,
        &Catalogue { models: vec![] },
        2 * GIB,
        2 * GIB + PERSIST_RESERVE_BYTES,
    )
    .unwrap();
    assert!(model.is_none());
}

#[test]
fn the_bundled_catalogue_is_valid_and_offers_nothing_unpinned() {
    let parsed = Catalogue::parse(BUNDLED_CATALOGUE).unwrap();
    assert!(parsed.models.is_empty());
    let unpinned = r#"{"models":[{"id":"x","name":"x","quality":"q","sizeBytes":1,"licenceName":"l","licenceText":"t","revision":"","sha256":"zz"}]}"#;
    assert_eq!(Catalogue::parse(unpinned), Err(CreateError::UnknownModel));
}

#[test]
fn a_model_needs_an_accepted_licence_and_a_known_id() {
    let c = catalogue();
    let id = Some("SYNTHETIC_FIXTURE_model".to_string());
    assert_eq!(
        check_capacity(
            &CreateOptions {
                model_id: id.clone(),
                licence_accepted: false
            },
            &c,
            GIB,
            100 * GIB
        )
        .unwrap_err(),
        CreateError::LicenceNotAccepted
    );
    assert_eq!(
        check_capacity(
            &CreateOptions {
                model_id: Some("other".into()),
                licence_accepted: true
            },
            &c,
            GIB,
            100 * GIB
        )
        .unwrap_err(),
        CreateError::UnknownModel
    );
    assert!(
        check_capacity(
            &CreateOptions {
                model_id: id,
                licence_accepted: true
            },
            &c,
            GIB,
            100 * GIB
        )
        .unwrap()
        .is_some()
    );
}

#[test]
fn undersized_disks_and_reserve_shortfalls_are_refused() {
    let c = catalogue();
    let with_model = CreateOptions {
        model_id: Some("SYNTHETIC_FIXTURE_model".into()),
        licence_accepted: true,
    };
    let image = 2 * GIB;
    let exact = image + 3 * GIB + PERSIST_RESERVE_BYTES;
    assert!(check_capacity(&with_model, &c, image, exact).is_ok());
    assert_eq!(
        check_capacity(&with_model, &c, image, exact - 1).unwrap_err(),
        CreateError::UndersizedDisk
    );
    let without = CreateOptions {
        model_id: None,
        licence_accepted: false,
    };
    assert_eq!(
        check_capacity(&without, &c, image, image + PERSIST_RESERVE_BYTES - 1).unwrap_err(),
        CreateError::UndersizedDisk
    );
    assert_eq!(
        check_capacity(&without, &c, u64::MAX, u64::MAX).unwrap_err(),
        CreateError::UndersizedDisk
    );
}

#[test]
fn passphrases_are_length_checked_matched_and_redacted() {
    assert_eq!(
        Passphrase::new("short".into(), "short").unwrap_err(),
        CreateError::PassphraseShort
    );
    assert_eq!(
        Passphrase::new("a".repeat(12), &"b".repeat(12)).unwrap_err(),
        CreateError::PassphraseMismatch
    );
    assert_eq!(
        Passphrase::new("é".repeat(1025), &"é".repeat(1025)).unwrap_err(),
        CreateError::PassphraseLong
    );
    let ok = Passphrase::new("SYNTHETIC_FIXTURE_12".into(), "SYNTHETIC_FIXTURE_12").unwrap();
    assert_eq!(format!("{ok:?}"), "Passphrase(redacted)");
    assert_eq!(ok.expose(), "SYNTHETIC_FIXTURE_12");
}
