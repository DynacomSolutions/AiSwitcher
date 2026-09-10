//! Tab 7 (index 6): per-tool-call token & cost breakdown, bar style.
//!
//! The endpoint answers one result per (tool, identity) pair; `,` / `.`
//! cycle the pair this view renders. Every number is an ESTIMATE off local
//! session logs: output tokens are split evenly across a turn's tool calls
//! and prompt-side tokens sit on the "chat" row (see the collector's
//! attribution rule in src/cli/usage/breakdown.ts).

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use crate::app::App;
use crate::models::{BreakdownCategory, BreakdownResult};
use crate::ui::widgets;

const TAB_INDEX: usize = 6;
/// Top consumers rendered before the list truncates.
const MAX_ROWS: usize = 12;
const BAR_WIDTH: usize = 18;
const NAME_WIDTH: usize = 26;

const KIND_LABELS: [&str; 5] = ["chat", "mcp", "edit", "web", "tool"];

fn kind_label(category: &BreakdownCategory) -> &'static str {
    match category.kind.as_deref() {
        Some("conversation") => KIND_LABELS[0],
        Some("mcp") => KIND_LABELS[1],
        Some("edit") => KIND_LABELS[2],
        Some("web") => KIND_LABELS[3],
        Some("tool") => KIND_LABELS[4],
        _ => "-",
    }
}

fn kind_style(category: &BreakdownCategory) -> ratatui::style::Style {
    use ratatui::style::Style;
    match category.kind.as_deref() {
        Some("mcp") => Style::new().cyan(),
        Some("edit") => Style::new().green(),
        Some("web") => Style::new().yellow(),
        _ => Style::new().dark_gray(),
    }
}

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Breakdown");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let lines: Vec<Line> = match &app.breakdown.data {
        Some(data) if data.results.is_empty() => {
            vec![Line::from(Span::from("no breakdown results reported").dark_gray())]
        }
        Some(data) => {
            let count = data.results.len();
            app.breakdown_selection = app.breakdown_selection.min(count.saturating_sub(1));
            let result = &data.results[app.breakdown_selection];
            render_result(result, app.breakdown_selection, count)
        }
        None => {
            let line = match app.breakdown.error.as_deref() {
                Some(message) => widgets::error_line(message),
                None => widgets::loading_line("waiting for /api/usage/breakdown", app.frame),
            };
            vec![line]
        }
    };

    widgets::clamp_scroll(&mut app.scrolls[TAB_INDEX], usize::from(inner.height), lines.len());
    let skip = app.scrolls[TAB_INDEX];
    let text = Text::from(lines.into_iter().skip(skip).collect::<Vec<_>>());
    f.render_widget(Paragraph::new(text), inner);
}

fn render_result(result: &BreakdownResult, index: usize, count: usize) -> Vec<Line<'static>> {
    let identity = result.identity.as_deref().unwrap_or("?");
    let tool = result.tool.as_deref().unwrap_or("?");
    let window = result.window_days.unwrap_or(30);

    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        Span::from(format!("{identity} ({tool})")).cyan().bold(),
        Span::from(format!(
            "  last {window}d · {} file{} · result {}/{}",
            result.files_read.unwrap_or(0),
            if result.files_read.unwrap_or(0) == 1 { "" } else { "s" },
            index + 1,
            count,
        ))
        .dark_gray(),
    ]));

    if let Some(reason) = &result.unavailable {
        lines.push(Line::from(
            Span::from(format!("unavailable for {identity}/{tool}: {reason}")).yellow(),
        ));
        lines.push(Line::from(Span::from("its local logs carry no per-call data to attribute").dark_gray()));
        return lines;
    }

    let categories = &result.categories;
    let total_cost: f64 = categories.iter().filter_map(|c| c.est_cost_usd).sum();
    let total_calls: f64 = categories.iter().filter_map(|c| c.call_count).sum();
    let total_output: f64 = categories.iter().filter_map(|c| c.output_tokens).sum();
    let total_input: f64 = categories.iter().filter_map(|c| c.input_tokens).sum();
    lines.push(Line::from(vec![
        Span::from(format!(
            "est {} total · {} calls · {} in / {} out tokens",
            widgets::money(total_cost),
            widgets::human_count(total_calls),
            widgets::human_count(total_input),
            widgets::human_count(total_output),
        ))
        .bold(),
        Span::from("  (estimated, never real billed spend)").dark_gray(),
    ]));
    if !result.notes.is_empty() {
        lines.push(Line::from(Span::from(result.notes.join("; ")).dark_gray()));
    }
    lines.push(Line::default());

    for category in categories.iter().take(MAX_ROWS) {
        lines.push(category_line(category, total_cost));
    }
    if categories.len() > MAX_ROWS {
        lines.push(Line::from(
            Span::from(format!("… {} more rows in the web UI or --json", categories.len() - MAX_ROWS)).dark_gray(),
        ));
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::from(",/. switch identity · estimates from local logs, attribution is heuristic").dark_gray()));
    lines
}

fn category_line(category: &BreakdownCategory, total_cost: f64) -> Line<'static> {
    let name = widgets::ellipsize(category.name.as_deref().unwrap_or("?"), NAME_WIDTH);
    let cost = category.est_cost_usd.unwrap_or(0.0);
    let share = if total_cost > 0.0 { cost / total_cost } else { 0.0 };
    let bar = widgets::gauge(share * 100.0, BAR_WIDTH);
    Line::from(vec![
        Span::from(format!("{:>5} ", kind_label(category))).style(kind_style(category)),
        Span::from(format!("{name:<NAME_WIDTH$} ")),
        Span::from(bar).cyan(),
        Span::from(format!(" {:>9}", widgets::money(cost))),
        Span::from(format!("  {:>5} calls", widgets::human_count(category.call_count.unwrap_or(0.0)))).dark_gray(),
        Span::from(format!("  {:>7} in", widgets::human_count(category.input_tokens.unwrap_or(0.0)))).dark_gray(),
        Span::from(format!("  {:>7} out", widgets::human_count(category.output_tokens.unwrap_or(0.0)))).dark_gray(),
    ])
}
