use ais_host_core::release::{
    AssetIdentity, ImageVerifier, PublishedRelease, TrustError, parse_checksums, select_release,
};

#[test]
fn production_trust_is_unavailable_without_signed_layout_contract() {
    match ImageVerifier::bundled() {
        Ok(_) => {}
        Err(TrustError::ContractUnavailable | TrustError::Signature) => {}
        Err(error) => panic!("unexpected bundled trust result: {error:?}"),
    }
}

#[test]
fn rejects_ambiguous_or_unsafe_checksum_entries() {
    let hash = "0".repeat(64);
    for sums in [
        format!("{hash}  image\n{hash}  image\n"),
        format!("{hash}  ../image\n"),
        format!("{hash}  /image\n"),
        format!("{hash}  image/file\n"),
        format!("{hash}  image\\file\n"),
        format!("{hash}  image\n\n"),
        "bad checksum".to_owned(),
        String::new(),
    ] {
        assert!(
            parse_checksums(sums.as_bytes()).is_err(),
            "unsafe sums accepted"
        );
    }
    assert_eq!(
        parse_checksums(format!("{hash} *image\n").as_bytes())
            .unwrap()
            .len(),
        1
    );
}

fn release(id: u64, date: u64) -> PublishedRelease {
    PublishedRelease {
        id,
        published_at: date,
        tag: format!("live-v{id}.0.0"),
        draft: false,
        prerelease: false,
        assets: [
            format!("ais-live-x86_64-live-v{id}.0.0.img.zst"),
            "SHA256SUMS".into(),
            "SHA256SUMS.minisig".into(),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, name)| AssetIdentity {
            id: index as u64 + 1,
            name,
            size: 100,
            revision: "SYNTHETIC_FIXTURE".into(),
        })
        .collect(),
    }
}

#[test]
fn selects_published_stable_tag_and_pins_asset_identities() {
    let mut releases = vec![release(1, 4), release(2, 3), release(3, 10)];
    releases[2].draft = true;
    let selection = select_release(&releases).unwrap();
    assert_eq!(selection.tag(), "live-v1.0.0");
    releases[0].assets[0].id = 99;
    assert_eq!(selection.image().id, 1);
    let duplicate = releases[0].assets[0].clone();
    releases[0].assets.push(duplicate);
    assert!(select_release(&releases).is_err());
    releases[0].assets.pop();
    releases[0].prerelease = true;
    assert_eq!(select_release(&releases).unwrap().tag(), "live-v2.0.0");
}

#[test]
fn malformed_older_release_is_preserved_as_fatal_when_fallback_reaches_it() {
    use ais_host_core::release::select_release_candidates;

    let newest = release(3, 30);
    let mut malformed_older = release(2, 20);
    malformed_older.assets.pop();
    let oldest = release(1, 10);
    let ordered = select_release_candidates(&[oldest, malformed_older, newest]);
    assert_eq!(ordered.len(), 3);
    assert_eq!(ordered[0].as_ref().unwrap().tag(), "live-v3.0.0");
    assert!(matches!(ordered[1], Err(TrustError::AssetIdentity)));
    assert_eq!(ordered[2].as_ref().unwrap().tag(), "live-v1.0.0");
}

#[cfg(feature = "file-test")]
mod signed {
    use super::*;
    use ais_host_core::file_test::SyntheticRelease;
    use std::io::{Seek, SeekFrom, Write};

    fn fixture() -> SyntheticRelease {
        SyntheticRelease::new(vec![0x45; 128 * 1024])
    }

    #[test]
    fn valid_signature_checksum_and_layout_produce_verified_bytes() {
        let fixture = fixture();
        let (_, image) = fixture.verify(&std::env::temp_dir()).unwrap();
        assert_eq!(image.len(), fixture.raw.len() as u64);
        assert_eq!(image.digest(), ais_host_core::release::sha256(&fixture.raw));
    }

    #[test]
    fn wrong_key_mutated_sums_and_asset_substitution_fail() {
        let other = fixture();
        let fixture = fixture();
        let (_, download) = fixture.download(&std::env::temp_dir()).unwrap();
        let wrong = ImageVerifier::synthetic(&other.public_key, &fixture.raw).unwrap();
        assert!(matches!(
            wrong.verify(&fixture.selection, download),
            Err(TrustError::Signature)
        ));
        let verifier = ImageVerifier::synthetic(&fixture.public_key, &fixture.raw).unwrap();
        let (_, mut download) = fixture.download(&std::env::temp_dir()).unwrap();
        download.sums[0] ^= 1;
        assert!(matches!(
            verifier.verify(&fixture.selection, download),
            Err(TrustError::Signature)
        ));
        let (_, mut download) = fixture.download(&std::env::temp_dir()).unwrap();
        download.image_identity.id += 1;
        assert!(matches!(
            verifier.verify(&fixture.selection, download),
            Err(TrustError::AssetIdentity)
        ));
    }

    #[test]
    fn wrong_image_and_layout_and_expansion_limit_fail() {
        let fixture = fixture();
        let verifier = ImageVerifier::synthetic(&fixture.public_key, &fixture.raw).unwrap();
        let (_, mut download) = fixture.download(&std::env::temp_dir()).unwrap();
        download.source.seek(SeekFrom::Start(0)).unwrap();
        download.source.write_all(&[0]).unwrap();
        assert!(matches!(
            verifier.verify(&fixture.selection, download),
            Err(TrustError::Checksum)
        ));
        let (_, download) = fixture.download(&std::env::temp_dir()).unwrap();
        let wrong_layout =
            ImageVerifier::synthetic(&fixture.public_key, &vec![0x46; fixture.raw.len()]).unwrap();
        assert!(matches!(
            wrong_layout.verify(&fixture.selection, download),
            Err(TrustError::Layout)
        ));
        let (_, download) = fixture.download(&std::env::temp_dir()).unwrap();
        let smaller = ImageVerifier::synthetic(&fixture.public_key, &fixture.raw[..512]).unwrap();
        assert!(matches!(
            smaller.verify(&fixture.selection, download),
            Err(TrustError::Limit)
        ));
    }

    #[test]
    fn source_handle_detects_in_place_change_after_verification() {
        let fixture = fixture();
        let (path, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
        let mut changed = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        changed.write_all(&[0]).unwrap();
        assert!(matches!(
            image.revalidate_source(),
            Err(TrustError::Checksum)
        ));
    }

    #[test]
    fn source_path_replacement_does_not_change_the_opened_image() {
        let fixture = fixture();
        let (path, mut image) = fixture.verify(&std::env::temp_dir()).unwrap();
        let moved = path.with_extension("retained");
        std::fs::rename(&path, moved).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap()
            .write_all(b"SYNTHETIC_FIXTURE")
            .unwrap();
        image.revalidate_source().unwrap();
    }

    #[test]
    fn signed_truncated_zstd_is_rejected_after_valid_checksum() {
        let mut compressed = zstd::stream::encode_all(vec![0x45; 4096].as_slice(), 1).unwrap();
        compressed.truncate(compressed.len() - 2);
        let fixture = SyntheticRelease::from_compressed(vec![0x45; 4096], compressed);
        assert!(fixture.verify(&std::env::temp_dir()).is_err());
    }

    #[test]
    fn incompatible_newest_falls_back_but_bad_signature_is_fatal() {
        use ais_host_core::{layout::synthetic_sfdisk_contract_fixture, release::ImageVerifier};

        let anchor = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let anchor_text = anchor.pk.to_box().unwrap().to_string();
        let compatible =
            SyntheticRelease::new_with_key(synthetic_sfdisk_contract_fixture(), &anchor);
        let incompatible = SyntheticRelease::new_with_key(vec![0x45; 64 * 1024], &anchor);
        let verifier = ImageVerifier::synthetic_live_layout(&anchor_text).unwrap();
        let (_, incompatible_download) = incompatible.download(&std::env::temp_dir()).unwrap();
        let (_, compatible_download) = compatible.download(&std::env::temp_dir()).unwrap();
        let verified = verifier
            .verify_candidates([
                Ok((incompatible.selection.clone(), incompatible_download)),
                Ok((compatible.selection.clone(), compatible_download)),
            ])
            .expect("older authenticated compatible image should be selected");
        assert_eq!(
            verified.digest(),
            ais_host_core::release::sha256(&compatible.raw)
        );

        let attacker = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let bad_signature = SyntheticRelease::new_with_key(compatible.raw.clone(), &attacker);
        let (_, bad_download) = bad_signature.download(&std::env::temp_dir()).unwrap();
        let (_, fallback_download) = compatible.download(&std::env::temp_dir()).unwrap();
        assert!(matches!(
            verifier.verify_candidates([
                Ok((bad_signature.selection.clone(), bad_download)),
                Ok((compatible.selection.clone(), fallback_download)),
            ]),
            Err(TrustError::Signature)
        ));
    }
}
