//! One explicitly entitled query scope for app writes/reads and helper deletion.
use super::{EscrowError, SERVICE};

const GROUP_SUFFIX: &str = "invalid.example.ais-host.escrow";

pub(super) struct KeychainAttributes<'a> {
    pub service: &'static str,
    pub account: &'a str,
    pub access_group: String,
    pub synchronisable: bool,
    pub data_protection: bool,
}

impl<'a> KeychainAttributes<'a> {
    pub fn from_entitlements(
        account: &'a str,
        team: &str,
        groups: &[String],
    ) -> Result<Self, EscrowError> {
        // Values come from the current executable's signed entitlements, never
        // environment overrides or the drive. Unexpanded signing templates fail.
        if team.is_empty()
            || team.len() > 64
            || !team.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(EscrowError::Unavailable);
        }
        let access_group = format!("{team}.{GROUP_SUFFIX}");
        if !groups.contains(&access_group) {
            // Missing from a query can mean an unauthorised access group. Do
            // not issue that query or misreport its result as successful cleanup.
            return Err(EscrowError::Unavailable);
        }
        Ok(Self {
            service: SERVICE,
            account,
            access_group,
            synchronisable: false,
            data_protection: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEAM: &str = "SYNTHETIC_FIXTURE_TEAM";
    const ACCOUNT: &str = "SYNTHETIC_FIXTURE_account";

    #[test]
    fn queries_require_the_same_dedicated_non_roaming_group() {
        let group = format!("{TEAM}.invalid.example.ais-host.escrow");
        let attributes =
            KeychainAttributes::from_entitlements(ACCOUNT, TEAM, std::slice::from_ref(&group))
                .unwrap();
        assert_eq!(attributes.service, "ais-host-escrow");
        assert_eq!(attributes.account, ACCOUNT);
        assert_eq!(attributes.access_group, group);
        assert!(!attributes.synchronisable);
        assert!(attributes.data_protection);
    }

    #[test]
    fn missing_private_or_wrong_team_entitlements_fail_closed() {
        for groups in [
            vec![],
            vec![format!("{TEAM}.invalid.example.ais-host")],
            vec!["SYNTHETIC_FIXTURE_OTHER.invalid.example.ais-host.escrow".into()],
        ] {
            assert!(matches!(
                KeychainAttributes::from_entitlements(ACCOUNT, TEAM, &groups),
                Err(EscrowError::Unavailable)
            ));
        }
        assert!(
            KeychainAttributes::from_entitlements(ACCOUNT, "$(DEVELOPMENT_TEAM)", &[]).is_err()
        );
    }

    #[test]
    fn app_and_separate_helper_templates_grant_exactly_the_shared_group() {
        let app = include_str!("../../../../../packaging/macos/escrow-app.entitlements.plist");
        let helper =
            include_str!("../../../../../packaging/macos/escrow-helper.entitlements.plist");
        for template in [app, helper] {
            let rendered = template.replace("$(DEVELOPMENT_TEAM)", TEAM);
            let group_array = rendered
                .split("<key>keychain-access-groups</key>")
                .nth(1)
                .unwrap()
                .split("</array>")
                .next()
                .unwrap();
            assert_eq!(group_array.matches("<string>").count(), 1);
            let group = group_array
                .split("<string>")
                .nth(1)
                .unwrap()
                .split("</string>")
                .next()
                .unwrap();
            let attributes =
                KeychainAttributes::from_entitlements(ACCOUNT, TEAM, &[group.into()]).unwrap();
            assert_eq!(attributes.access_group, group);
            assert!(rendered.contains(&format!(
                "<key>com.apple.developer.team-identifier</key>\n    <string>{TEAM}</string>"
            )));
        }
        assert!(app.contains("<string>$(DEVELOPMENT_TEAM).invalid.example.ais-host</string>"));
        assert!(helper.contains(
            "<string>$(DEVELOPMENT_TEAM).invalid.example.ais-host.escrow-purge</string>"
        ));
    }
}
