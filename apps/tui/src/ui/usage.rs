//! Tab 4: provider-first usage totals.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Rect};
use ratatui::style::{Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Row, Table};

use crate::app::App;
use crate::models::{DateSpan, UsageResult};
use crate::timefmt;
use crate::ui::widgets;

const TAB_INDEX: usize = 3;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Usage");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let header = Row::new([
        "PROVIDER",
        "IDENTITY",
        "DATE SPAN",
        "IN",
        "OUT",
        "CACHE",
        "COST",
        "ERROR",
    ])
    .style(Style::new().dark_gray().bold());

    let mut rows: Vec<Row> = Vec::new();
    match &app.usage.data {
        Some(data) if data.results.is_empty() => {
            rows.push(Row::new([Cell::from(
                Span::from("no usage results reported").dark_gray(),
            )]));
        }
        Some(data) => {
            for result in &data.results {
                rows.push(result_row(result));
            }
        }
        None => {
            let cell = match app.usage.error.as_deref() {
                Some(message) => Cell::from(widgets::error_line(message)),
                None => Cell::from(widgets::loading_line("waiting for /api/usage", app.frame)),
            };
            rows.push(Row::new([cell]));
        }
    }

    let widths = [
        Constraint::Length(12),
        Constraint::Length(14),
        Constraint::Length(17),
        Constraint::Length(9),
        Constraint::Length(9),
        Constraint::Length(9),
        Constraint::Length(9),
        Constraint::Min(10),
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

fn result_row(result: &UsageResult) -> Row<'static> {
    let identity = result.identity.name().to_string();
    let provider = result
        .provider
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let numbers = |value: Option<f64>| -> String {
        value
            .map(widgets::human_count)
            .unwrap_or_else(|| "-".to_string())
    };

    match &result.report {
        Some(report) => {
            let cache_total =
                report.total_cache_read.unwrap_or(0.0) + report.total_cache_write.unwrap_or(0.0);
            let cost = report
                .total_cost
                .map(widgets::money)
                .unwrap_or_else(|| "-".to_string());
            let error_span = match &result.error {
                Some(message) => Span::from(widgets::ellipsize(message, 60)).red(),
                None => Span::from(String::new()),
            };
            Row::new(vec![
                Cell::from(Span::from(provider).cyan().bold()),
                Cell::from(identity),
                right(date_span_text(result.date_span.as_ref())).dark_gray(),
                right(numbers(report.total_input)),
                right(numbers(report.total_output)),
                right(numbers(Some(cache_total))),
                right(cost),
                Cell::from(error_span),
            ])
        }
        None => {
            let message = result
                .error
                .clone()
                .unwrap_or_else(|| "no data".to_string());
            Row::new(vec![
                Cell::from(Span::from(provider).cyan()),
                Cell::from(identity),
                right(date_span_text(result.date_span.as_ref())).dark_gray(),
                right("-"),
                right("-"),
                right("-"),
                right("-"),
                Cell::from(Span::from(widgets::ellipsize(&message, 80)).red()),
            ])
        }
    }
}

fn date_span_text(span: Option<&DateSpan>) -> String {
    let Some(span) = span else {
        return "-".to_string();
    };
    match (span.first_ms, span.last_ms) {
        (Some(first), Some(last)) if first == last => timefmt::short_date_ms(first),
        (Some(first), Some(last)) => {
            format!(
                "{} to {}",
                timefmt::short_date_ms(first),
                timefmt::short_date_ms(last)
            )
        }
        _ => "-".to_string(),
    }
}

/// Right-aligned cell content for numeric columns.
fn right(text: impl Into<String>) -> Cell<'static> {
    Cell::from(Line::from(Span::from(text.into())).alignment(Alignment::Right))
}
