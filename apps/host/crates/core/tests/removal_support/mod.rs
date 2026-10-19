#![allow(dead_code)]
use ais_host_core::{
    contract::sha256_hex,
    flow_state::{DriveBinding, FlowStore},
    logs::{OutboxFreshness, PullLogsResult},
    remove::RemovalBackend,
    revocation::{CredentialScope, RevocationBackend, RevocationMethod},
};

pub const IDENTITY: &str = "SYNTHETIC_FIXTURE_identity";
pub const SHARED: &str = "SYNTHETIC_FIXTURE_shared_identity";
pub const GRANT: &str = "SYNTHETIC_FIXTURE_grant";
pub fn scope(method: RevocationMethod) -> CredentialScope {
    CredentialScope {
        handle: GRANT.into(),
        provider: "SYNTHETIC_FIXTURE_provider".into(),
        fingerprint: sha256_hex(b"SYNTHETIC_FIXTURE_credential"),
        affected_identities: vec![IDENTITY.into(), SHARED.into()],
        method,
    }
}
pub struct FakeRemoval {
    pub scopes: Vec<CredentialScope>,
    pub pulls: usize,
    pub forgets: usize,
    pub revokes: Vec<String>,
    pub inventories: usize,
    pub fail_logs: bool,
    pub incomplete_logs: bool,
    pub fail_revoke: bool,
    pub fail_forget: bool,
}
impl Default for FakeRemoval {
    fn default() -> Self {
        Self {
            scopes: vec![scope(RevocationMethod::ProviderGrant)],
            pulls: 0,
            forgets: 0,
            revokes: Vec::new(),
            inventories: 0,
            fail_logs: false,
            incomplete_logs: false,
            fail_revoke: false,
            fail_forget: false,
        }
    }
}
impl RevocationBackend for FakeRemoval {
    fn inventory(&mut self, _: &DriveBinding) -> Result<Vec<CredentialScope>, String> {
        self.inventories += 1;
        Ok(self.scopes.clone())
    }
    fn revoke(&mut self, scope: &CredentialScope) -> Result<(), String> {
        self.revokes.push(scope.handle.clone());
        if self.fail_revoke {
            Err("SYNTHETIC_FIXTURE revocation failure".into())
        } else {
            Ok(())
        }
    }
}
impl RemovalBackend for FakeRemoval {
    fn pull_logs(
        &mut self,
        _: &DriveBinding,
        _: &mut dyn FlowStore,
    ) -> Result<PullLogsResult, String> {
        self.pulls += 1;
        if self.fail_logs {
            return Err("SYNTHETIC_FIXTURE log failure".into());
        }
        Ok(PullLogsResult {
            imported: 1,
            duplicates: 0,
            truncated: false,
            captured_at: "2026-10-19T04:00:00Z".into(),
            freshness: OutboxFreshness::Unknown,
            conflicts: vec![],
            complete: !self.incomplete_logs,
        })
    }
    fn forget_drive(&mut self, _: &DriveBinding) -> Result<(), String> {
        self.forgets += 1;
        if self.fail_forget {
            Err("SYNTHETIC_FIXTURE forget failure".into())
        } else {
            Ok(())
        }
    }
}
