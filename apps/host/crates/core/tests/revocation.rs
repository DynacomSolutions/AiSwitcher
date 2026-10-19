mod flow_support;
mod removal_support;
use ais_host_core::{
    contract::sha256_hex,
    revocation::{RevocationEffect, RevocationMethod, RevocationReview, revoke_one},
};
use flow_support::binding;
use removal_support::*;
use std::collections::BTreeSet;

#[test]
fn shared_identity_consent_is_required_and_bound_to_current_fingerprints() {
    let mut backend = FakeRemoval::default();
    let review = RevocationReview::prepare(&mut backend, &binding()).unwrap();
    let partial = BTreeSet::from([IDENTITY.into()]);
    assert_eq!(
        revoke_one(&mut backend, &binding(), &review, GRANT, &partial)
            .unwrap()
            .effect,
        RevocationEffect::ConsentRequired
    );
    assert!(backend.revokes.is_empty());
    backend.scopes[0].fingerprint = sha256_hex(b"SYNTHETIC_FIXTURE_rotated_credential");
    assert!(
        revoke_one(
            &mut backend,
            &binding(),
            &review,
            GRANT,
            &BTreeSet::from([IDENTITY.into(), SHARED.into()])
        )
        .is_err()
    );
    assert!(backend.revokes.is_empty());
}

#[test]
fn grant_revocation_local_deletion_and_unsupported_providers_are_distinct() {
    for (method, effect) in [
        (
            RevocationMethod::ProviderGrant,
            RevocationEffect::GrantRevoked,
        ),
        (
            RevocationMethod::LocalCredentialDeletion,
            RevocationEffect::LocalCredentialDeleted,
        ),
        (RevocationMethod::Unsupported, RevocationEffect::Unsupported),
    ] {
        let mut backend = FakeRemoval {
            scopes: vec![scope(method)],
            ..Default::default()
        };
        let review = RevocationReview::prepare(&mut backend, &binding()).unwrap();
        let result = revoke_one(
            &mut backend,
            &binding(),
            &review,
            GRANT,
            &BTreeSet::from([IDENTITY.into(), SHARED.into()]),
        )
        .unwrap();
        assert_eq!(result.effect, effect);
        assert_eq!(
            backend.revokes.len(),
            usize::from(method != RevocationMethod::Unsupported)
        );
        assert_eq!(
            result.next_action.is_some(),
            method != RevocationMethod::ProviderGrant
        );
    }
}

#[test]
fn provider_failures_are_actionable_without_leaking_backend_errors() {
    let mut backend = FakeRemoval {
        fail_revoke: true,
        ..Default::default()
    };
    let review = RevocationReview::prepare(&mut backend, &binding()).unwrap();
    let result = revoke_one(
        &mut backend,
        &binding(),
        &review,
        GRANT,
        &BTreeSet::from([IDENTITY.into(), SHARED.into()]),
    )
    .unwrap();
    assert_eq!(result.effect, RevocationEffect::Failed);
    assert!(result.next_action.unwrap().contains("retry"));
}

#[test]
fn a_damaged_review_is_rejected_before_inventory_or_revocation() {
    let mut backend = FakeRemoval::default();
    let mut review = RevocationReview::prepare(&mut backend, &binding()).unwrap();
    review.digest = sha256_hex(b"SYNTHETIC_FIXTURE_wrong_review");
    let inventories = backend.inventories;
    assert!(
        revoke_one(
            &mut backend,
            &binding(),
            &review,
            GRANT,
            &BTreeSet::from([IDENTITY.into(), SHARED.into()])
        )
        .is_err()
    );
    assert_eq!(backend.inventories, inventories);
    assert!(backend.revokes.is_empty());
}
