// The elevated Windows helper resolves its imports from System32 only, so a
// DLL planted beside it is never loaded (LOAD_LIBRARY_SEARCH_SYSTEM32). The
// load-config flag is checked in CI by scripts/host/pe-load-flags.ts.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let windows = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
    if windows && msvc {
        println!("cargo:rustc-link-arg-bin=ais-host-helper=/DEPENDENTLOADFLAG:0x800");
    }
}
