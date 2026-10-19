use super::{
    EscrowError, SecretString, decode, macos_attributes::KeychainAttributes, macos_entitlements,
};
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    passwords::{
        PasswordOptions, delete_generic_password_options, generic_password,
        set_generic_password_options,
    },
};

fn map(error: security_framework::base::Error) -> EscrowError {
    // Security framework OSStatus values. Do not expose native error text.
    match error.code() {
        -25300 => EscrowError::Missing,         // errSecItemNotFound
        -25308 | -25293 => EscrowError::Locked, // interaction/authentication
        _ => EscrowError::Unavailable,
    }
}

fn options_from_attributes(attributes: &KeychainAttributes<'_>) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(attributes.service, attributes.account);
    options.set_access_group(&attributes.access_group);
    options.set_access_synchronized(Some(attributes.synchronisable));
    if attributes.data_protection {
        options.use_protected_keychain();
    }
    options
}

fn options(account: &str) -> Result<PasswordOptions, EscrowError> {
    let (team, groups) = macos_entitlements::current()?;
    Ok(options_from_attributes(
        &KeychainAttributes::from_entitlements(account, &team, &groups)?,
    ))
}

pub(super) fn availability() -> Result<(), EscrowError> {
    options("").map(|_| ())
}

pub(super) fn put(account: &str, bytes: &[u8]) -> Result<(), EscrowError> {
    let mut options = options(account)?;
    options.set_access_control(
        SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(map)?,
    );
    set_generic_password_options(bytes, options).map_err(map)
}

pub(super) fn retrieve(account: &str) -> Result<SecretString, EscrowError> {
    decode(generic_password(options(account)?).map_err(map)?)
}

pub(super) fn delete(account: &str) -> Result<(), EscrowError> {
    // SecItemDelete directly, never find_generic_password (which reads data).
    match delete_generic_password_options(options(account)?).map_err(map) {
        Err(EscrowError::Missing) | Ok(()) => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(deprecated)] // Inspect the actual native query, not a parallel model.
    fn native_query_contains_shared_group_service_and_exact_account() {
        let group = "SYNTHETIC_FIXTURE_TEAM.invalid.example.ais-host.escrow";
        let attributes = KeychainAttributes::from_entitlements(
            "SYNTHETIC_FIXTURE_account",
            "SYNTHETIC_FIXTURE_TEAM",
            &[group.into()],
        )
        .unwrap();
        let query = options_from_attributes(&attributes).query;
        for (name, expected) in [
            ("agrp", group),
            ("svce", "ais-host-escrow"),
            ("acct", "SYNTHETIC_FIXTURE_account"),
        ] {
            let (key, value) = query.iter().find(|(key, _)| *key == name).unwrap();
            // Infer CFString through the wrapper's public query to avoid a new
            // direct CoreFoundation dependency solely for this assertion.
            let mut expected_string = key.clone();
            expected_string.clone_from(&expected.into());
            assert_eq!(value.downcast().as_ref(), Some(&expected_string));
        }
    }
}
