//! Tab 2: identity registries, grouped per tool. Read-only in v1.
//!
//! Rendered as full-width lines rather than a table so each registry's
//! header can carry its registry path without being clipped by a column.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use crate::app::App;
use crate::models::{IdentityEntry, Registry};
use crate::ui::widgets;

const TAB_INDEX: usize = 1;
const NAME_W: usize = 16;
const LABEL_W: usize = 18;
const ALIASES_W: usize = 12;
const DIRS_W: usize = 6;
const CHECK_W: usize = 4;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Identities");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let mut lines: Vec<Line> = vec![header_line()];
    match &app.identities.data {
        Some(data) if data.registries.is_empty() => {
            lines.push(Line::from(Span::from("no registries reported").dark_gray()));
        }
        Some(data) => {
            for registry in &data.registries {
                push_registry(&mut lines, registry);
            }
            if data.registries.is_empty() {
                // handled above; kept for exhaustiveness clarity
            }
        }
        None => match app.identities.error.as_deref() {
            Some(message) => {
                lines[0] = widgets::error_line(message);
            }
            None => {
                lines[0] = widgets::loading_line("waiting for /api/identities", app.frame);
            }
        },
    }

    let visible = usize::from(inner.height);
    widgets::clamp_scroll(&mut app.scrolls[TAB_INDEX], visible, lines.len());
    let offset = u16::try_from(app.scrolls[TAB_INDEX]).unwrap_or(u16::MAX);
    f.render_widget(Paragraph::new(Text::from(lines)).scroll((offset, 0)), inner);
}

fn header_line() -> Line<'static> {
    Line::from(vec![
        Span::from(format!("  {:<NAME_W$}", "NAME"))
            .dark_gray()
            .bold(),
        Span::from(format!("{:<LABEL_W$}", "LABEL"))
            .dark_gray()
            .bold(),
        Span::from(format!("{:<ALIASES_W$}", "ALIASES"))
            .dark_gray()
            .bold(),
        Span::from(format!("{:<DIRS_W$}", "DIRS"))
            .dark_gray()
            .bold(),
        Span::from(format!("{:<CHECK_W$}", "DIR"))
            .dark_gray()
            .bold(),
        Span::from("CONFIG DIR").dark_gray().bold(),
    ])
}

fn push_registry(lines: &mut Vec<Line<'static>>, registry: &Registry) {
    lines.push(Line::default());
    lines.push(Line::from(vec![
        Span::from(" "),
        Span::from(registry.tool_name.clone().unwrap_or_default())
            .cyan()
            .bold(),
        Span::from("   "),
        Span::from(registry.path.clone().unwrap_or_default()).dark_gray(),
    ]));
    if registry.identities.is_empty() {
        lines.push(Line::from(
            Span::from("     (no identities registered)").dark_gray(),
        ));
        return;
    }
    for identity in &registry.identities {
        lines.push(identity_line(identity));
    }
}

fn identity_line(identity: &IdentityEntry) -> Line<'static> {
    let aliases = if identity.aliases.is_empty() {
        String::new()
    } else {
        widgets::ellipsize(&identity.aliases.join(","), ALIASES_W)
    };
    let dirs = identity.directories.len().to_string();
    Line::from(vec![
        Span::from("  "),
        Span::from(pad_owned(
            widgets::ellipsize(identity.name.as_deref().unwrap_or("?"), NAME_W),
            NAME_W,
        ))
        .bold(),
        Span::from(pad_owned(
            widgets::ellipsize(identity.label.as_deref().unwrap_or(""), LABEL_W),
            LABEL_W,
        )),
        Span::from(pad_owned(aliases, ALIASES_W)).dark_gray(),
        Span::from(pad_owned(dirs, DIRS_W)),
        Span::from(pad_check(widgets::check_text(identity.config_dir_exists))),
        Span::from(widgets::ellipsize(
            identity.config_dir.as_deref().unwrap_or("-"),
            44,
        ))
        .dark_gray(),
    ])
}

fn pad(text: &str, width: usize) -> String {
    let mut owned = text.to_string();
    let len = owned.chars().count();
    if len < width {
        owned.push_str(&" ".repeat(width - len));
    }
    owned
}

/// Pad an owned value that is already truncated to the column.
fn pad_owned(text: String, width: usize) -> String {
    pad(&text, width)
}

/// Check glyphs are single-width symbols; one trailing space keeps columns apart.
fn pad_check(glyph: &str) -> String {
    format!("{glyph:<CHECK_W$}")
}
