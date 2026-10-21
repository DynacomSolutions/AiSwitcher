//! Provider-specific execution stays in the native auth adapter. This layer
//! binds consent to the reviewed grant fingerprints and affected identities.
//! There is no generic grant-revocation operation in the current host protocol.

use crate::{
    contract::sha256_hex,
    flow_state::{DriveBinding, valid_hash},
    registry::validate_handle,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevocationMethod {
    ProviderGrant,
    LocalCredentialDeletion,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialScope {
    pub handle: String,
    pub provider: String,
    pub fingerprint: String,
    pub affected_identities: Vec<String>,
    pub method: RevocationMethod,
}

impl CredentialScope {
    fn validate(&self) -> Result<(), String> {
        validate_handle(&self.handle).map_err(|_| "invalid credential handle")?;
        validate_handle(&self.provider).map_err(|_| "invalid provider handle")?;
        if !valid_hash(&self.fingerprint)
            || self.affected_identities.is_empty()
            || self.affected_identities.len() > 1024
        {
            return Err("invalid credential scope".into());
        }
        let mut seen = BTreeSet::new();
        for identity in &self.affected_identities {
            validate_handle(identity).map_err(|_| "invalid affected identity handle")?;
            if !seen.insert(identity) {
                return Err("duplicate affected identity".into());
            }
        }
        Ok(())
    }
}

pub trait RevocationBackend {
    fn inventory(&mut self, drive: &DriveBinding) -> Result<Vec<CredentialScope>, String>;
    /// Use the existing provider auth engine's locking and freshest-token rules.
    /// Revalidate the exact reviewed fingerprint and affected identities while
    /// holding that lock. An interrupted operation may be retried, so deletion
    /// must be idempotent and must never select a replacement grant by alias.
    /// Never retire an identity. Unsupported methods must not call this method.
    fn revoke(&mut self, scope: &CredentialScope) -> Result<(), String>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationReview {
    pub scopes: Vec<CredentialScope>,
    pub digest: String,
}

impl RevocationReview {
    pub(crate) fn empty(drive: &DriveBinding) -> Result<Self, String> {
        Self::from_scopes(drive, Vec::new())
    }

    pub fn prepare(
        backend: &mut dyn RevocationBackend,
        drive: &DriveBinding,
    ) -> Result<Self, String> {
        let mut scopes = backend
            .inventory(drive)
            .map_err(|_| "cannot review credential scope")?;
        if scopes.len() > 1024 {
            return Err("too many credential scopes".into());
        }
        scopes.sort_by(|a, b| a.handle.cmp(&b.handle));
        for scope in &mut scopes {
            scope.affected_identities.sort();
            scope.validate()?;
        }
        if scopes
            .windows(2)
            .any(|pair| pair[0].handle == pair[1].handle)
        {
            return Err("duplicate credential handle".into());
        }
        Self::from_scopes(drive, scopes)
    }

    fn from_scopes(drive: &DriveBinding, scopes: Vec<CredentialScope>) -> Result<Self, String> {
        let digest = sha256_hex(
            &serde_json::to_vec(&(drive, &scopes))
                .map_err(|_| "cannot identify credential scope")?,
        );
        let review = Self { scopes, digest };
        review.validate(drive)?;
        Ok(review)
    }

    pub(crate) fn validate(&self, drive: &DriveBinding) -> Result<(), String> {
        drive.validate()?;
        if self.scopes.len() > 1024
            || self
                .scopes
                .windows(2)
                .any(|pair| pair[0].handle >= pair[1].handle)
            || self.digest
                != sha256_hex(
                    &serde_json::to_vec(&(drive, &self.scopes))
                        .map_err(|_| "cannot identify credential scope")?,
                )
        {
            return Err("invalid credential review".into());
        }
        for scope in &self.scopes {
            scope.validate()?;
            if scope
                .affected_identities
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            {
                return Err("invalid affected identity order".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevocationEffect {
    GrantRevoked,
    LocalCredentialDeleted,
    Unsupported,
    Failed,
    ConsentRequired,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRevocationResult {
    pub handle: String,
    pub provider: String,
    pub effect: RevocationEffect,
    pub next_action: Option<String>,
}

/// Completed handles can be passed on a retry. The owning removal journal must
/// persist each successful effect before attempting another provider.
pub fn revoke_one(
    backend: &mut dyn RevocationBackend,
    drive: &DriveBinding,
    review: &RevocationReview,
    handle: &str,
    consented_identities: &BTreeSet<String>,
) -> Result<ProviderRevocationResult, String> {
    review.validate(drive)?;
    let scope = review
        .scopes
        .iter()
        .find(|scope| scope.handle == handle)
        .ok_or("credential is outside the reviewed scope")?;
    let current = RevocationReview::prepare(backend, drive)?;
    // Successful prior revocations may disappear from inventory. Compare the
    // selected scope exactly, allowing no change to its fingerprint or sharing.
    if current
        .scopes
        .iter()
        .find(|candidate| candidate.handle == handle)
        != Some(scope)
    {
        return Err("credential scope changed; review affected identities again".into());
    }
    let (effect, next_action) = if scope.method == RevocationMethod::Unsupported {
        (RevocationEffect::Unsupported, Some("Revoke the grant in the provider's account settings; this adapter cannot revoke it.".into()))
    } else if !scope
        .affected_identities
        .iter()
        .all(|identity| consented_identities.contains(identity))
    {
        (
            RevocationEffect::ConsentRequired,
            Some(
                "Confirm the listed affected identities before removing shared authentication."
                    .into(),
            ),
        )
    } else if backend.revoke(scope).is_err() {
        (RevocationEffect::Failed, Some("Check the selected authentication source and retry, or revoke the grant in the provider's account settings.".into()))
    } else {
        match scope.method {
            RevocationMethod::ProviderGrant => (RevocationEffect::GrantRevoked, None),
            RevocationMethod::LocalCredentialDeletion => (RevocationEffect::LocalCredentialDeleted, Some("The local credential was deleted. Revoke the provider grant separately if required.".into())),
            RevocationMethod::Unsupported => unreachable!(),
        }
    };
    Ok(ProviderRevocationResult {
        handle: scope.handle.clone(),
        provider: scope.provider.clone(),
        effect,
        next_action,
    })
}
