fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["write-safety"] {
        eprintln!("Usage: host-file-check write-safety");
        std::process::exit(2);
    }
    let directory = std::env::var_os("HOST_FILE_CHECK_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    match ais_host_core::file_test::run_write_safety(&directory) {
        Ok(count) => println!(
            "PASS: {count} regular-file scenarios; refusal targets and out-of-range sentinels preserved."
        ),
        Err(error) => {
            eprintln!("FAIL: {error}");
            std::process::exit(1);
        }
    }
}
