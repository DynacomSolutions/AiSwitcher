//! aistui: terminal dashboard for AiProfileSwitcher's local console API.

mod api;
mod app;
mod config;
mod embed;
mod herdr;
mod models;
mod overview;
mod summary;
mod timefmt;
mod ui;

use anyhow::Context;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `aistui herdr` is the native `ais herdr` wrapper: the real herdr
    // client embedded in a PTY on the left, the overview panel rendered
    // natively on the right (the tmux replacement). `aistui --overview` is
    // the compact single-screen variant; everything else is the tabbed
    // dashboard.
    let settings = if args.first().is_some_and(|arg| arg == "herdr") {
        None
    } else {
        Some(config::Settings::load().context("failed to resolve console settings")?)
    };
    // Enters raw mode + alternate screen and installs a panic hook that
    // restores the terminal even if a bug panics mid-draw.
    let terminal = ratatui::init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start async runtime")?;
    let result = match settings {
        // herdr mode resolves its own settings after parsing its argv.
        None => runtime.block_on(herdr::run(terminal, &args[1..])),
        Some(settings) => {
            if args.iter().any(|arg| arg == "--overview") {
                runtime.block_on(overview::run(terminal, settings))
            } else {
                runtime.block_on(app::run(terminal, settings))
            }
        }
    };

    // Restore unconditionally, success or error, so the shell is never left
    // in a broken state.
    ratatui::restore();
    result
}
