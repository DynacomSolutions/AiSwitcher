//! aistui: terminal dashboard for AiProfileSwitcher's local console API.

mod api;
mod app;
mod config;
mod models;
mod overview;
mod summary;
mod timefmt;
mod ui;

use anyhow::Context;

fn main() -> anyhow::Result<()> {
    // `aistui --overview` is the compact single-screen variant the
    // `ais herdr` wrapper runs in its right panel; everything else is the
    // tabbed dashboard.
    let overview_mode = std::env::args().skip(1).any(|arg| arg == "--overview");
    let settings = config::Settings::load().context("failed to resolve console settings")?;
    // Enters raw mode + alternate screen and installs a panic hook that
    // restores the terminal even if a bug panics mid-draw.
    let terminal = ratatui::init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start async runtime")?;
    let result = if overview_mode {
        runtime.block_on(overview::run(terminal, settings))
    } else {
        runtime.block_on(app::run(terminal, settings))
    };

    // Restore unconditionally, success or error, so the shell is never left
    // in a broken state.
    ratatui::restore();
    result
}
