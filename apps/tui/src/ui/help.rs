//! Tab 7: keys, configuration and about text.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use crate::app::App;
use crate::timefmt;
use crate::ui::widgets;

pub fn render(f: &mut Frame<'_>, app: &App, area: Rect) {
    let block = widgets::panel("Help");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<Line> = Vec::new();
    section(&mut lines, "Keys");
    key_line(&mut lines, "1-7", "jump straight to a tab");
    key_line(&mut lines, "Tab / Shift+Tab", "cycle tabs");
    key_line(&mut lines, "j / k, Up / Down", "scroll the active tab");
    key_line(&mut lines, "PgUp / PgDn", "scroll by a page");
    key_line(&mut lines, "r", "force refresh of the active tab's data");
    key_line(&mut lines, "q or Esc, Ctrl+C", "quit");

    section(&mut lines, "Configuration");
    info_line(&mut lines, "Console URL", &app.base_url);
    info_line(&mut lines, "Bearer token from", &app.token_source);
    info_line(
        &mut lines,
        "Polling",
        "status/processes 3s; identities/auth 10s; sessions 15s; limits/usage 60s (server caches 45s)",
    );
    info_line(
        &mut lines,
        "Scope note",
        "the TUI is a read-only view in v1: identity edits and auth fixes live in the web UI and the ais CLI",
    );

    section(&mut lines, "About");
    match &app.status.data {
        Some(status) => {
            let version = status.version.as_deref().unwrap_or("unknown");
            info_line(&mut lines, "ais version", version);
            if let Some(uptime_s) = status.uptime_s {
                info_line(
                    &mut lines,
                    "Console uptime",
                    &format!("{} and counting", timefmt::human_duration(uptime_s)),
                );
            }
            if let Some(home) = &status.home {
                info_line(&mut lines, "Home", home);
            }
            if let Some(ais_home) = &status.ais_home {
                info_line(&mut lines, "AIS home", ais_home);
            }
            info_line(
                &mut lines,
                "Frontend",
                "aistui: terminal dashboard over the local AIS Console API",
            );
        }
        None => lines.push(Line::from(
            Span::from("console status not fetched yet; showing defaults").dark_gray(),
        )),
    }

    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

fn section(lines: &mut Vec<Line<'static>>, title: &str) {
    if !lines.is_empty() {
        lines.push(Line::default());
    }
    lines.push(Line::from(Span::from(title.to_string()).cyan().bold()));
}

fn key_line(lines: &mut Vec<Line<'static>>, keys: &str, description: &str) {
    lines.push(Line::from(vec![
        Span::from(format!("  {keys:<22}")).yellow(),
        Span::from(description.to_string()),
    ]));
}

fn info_line(lines: &mut Vec<Line<'static>>, label: &str, value: &str) {
    lines.push(Line::from(vec![
        Span::from(format!("  {label:<22}")).dark_gray(),
        Span::from(widgets::ellipsize(value, 120)),
    ]));
}
