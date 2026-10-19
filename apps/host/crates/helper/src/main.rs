fn main() {
    // Never accept authority via arguments, stdin, an environment flag or an
    // unauthenticated local endpoint. Native peer verification is unavailable.
    eprintln!("An authorised native request channel is required. Disk writes are unavailable.");
    std::process::exit(77);
}
