//! Tab 6: per-identity auth health. Read-only in v1; fixes live in the web
//! UI and CLI.

use ratatui::Frame;
use ratatui::layout::{Constraint, Rect};
use ratatui::style::{Color, Style, Stylize};
use ratatui::text::Span;
use ratatui::widgets::{Cell, Row, Table};

use crate::app::App;
use crate::ui::widgets;

const TAB_INDEX: usize = 5;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Auth");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let header = Row::new(["TOOL", "IDENTITY", "KIND", "STATE", "DETAIL", "FIXABLE"])
        .style(Style::new().dark_gray().bold());

    let mut rows: Vec<Row> = Vec::new();
    match &app.auth.data {
        Some(data) if data.entries.is_empty() => {
            rows.push(Row::new([Cell::from(
                Span::from("no auth entries reported").dark_gray(),
            )]));
        }
        Some(data) => {
            for entry in &data.entries {
                rows.push(entry_row(entry));
            }
        }
        None => {
            let cell = match app.auth.error.as_deref() {
                Some(message) => Cell::from(widgets::error_line(message)),
                None => Cell::from(widgets::loading_line("waiting for /api/auth", app.frame)),
            };
            rows.push(Row::new([cell]));
        }
    }

    let widths = [
        Constraint::Length(8),
        Constraint::Length(14),
        Constraint::Length(8),
        Constraint::Length(10),
        Constraint::Min(16),
        Constraint::Length(16),
    ];
    let visible = usize::from(inner.height).saturating_sub(1);
    widgets::clamp_scroll(&mut app.scrolls[TAB_INDEX], visible, rows.len());
    let shown: Vec<Row> = rows
        .into_iter()
        .skip(app.scrolls[TAB_INDEX])
        .take(visible)
        .collect();

    let table = Table::new(shown, widths).header(header).column_spacing(2);
    f.render_widget(table, inner);
}

fn entry_row(entry: &crate::models::AuthEntry) -> Row<'static> {
    let state = entry.state.clone().unwrap_or_else(|| "unknown".to_string());
    let state_span = Span::from(state.clone()).style(state_style(&state));
    let fixable = if entry.fixable.is_empty() {
        String::new()
    } else {
        entry.fixable.join(",")
    };
    Row::new(vec![
        Cell::from(
            Span::from(entry.tool_name.clone().unwrap_or_default())
                .cyan()
                .bold(),
        ),
        Cell::from(entry.identity.clone().unwrap_or_default()),
        Cell::from(Span::from(entry.kind.clone().unwrap_or_default()).dark_gray()),
        Cell::from(state_span),
        Cell::from(widgets::ellipsize(
            entry.detail.as_deref().unwrap_or("-"),
            70,
        )),
        Cell::from(Span::from(fixable).yellow()),
    ])
}

fn state_style(state: &str) -> Style {
    match state {
        "ok" => Style::new().fg(Color::Green).bold(),
        "expiring" => Style::new().fg(Color::Yellow).bold(),
        "expired" => Style::new().fg(Color::Red).bold(),
        // Missing and unknown stay dim: noteworthy, not alarming.
        _ => Style::new().dark_gray(),
    }
}
