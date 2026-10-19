use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let anchor = manifest_dir.join("../../../../image/release-key.pub");
    println!("cargo:rerun-if-changed={}", anchor.display());
    let value = match fs::read_to_string(&anchor) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Keep in step with release::PLACEHOLDER_KEY_OVERRIDE_ENV.
            const OVERRIDE: &str = "AIS_ALLOW_PLACEHOLDER_RELEASE_KEY";
            println!("cargo:rerun-if-env-changed={OVERRIDE}");
            if env::var("PROFILE").is_ok_and(|profile| profile == "release")
                && env::var_os(OVERRIDE).is_none()
            {
                panic!(
                    "image/release-key.pub is missing: refusing to build a release with the placeholder production minisign key"
                );
            }
            String::new()
        }
        Err(error) => panic!("cannot read the reviewed image trust anchor: {error}"),
    };
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("bundled-image-key.txt"), value)
        .expect("write generated trust-anchor include");
}
