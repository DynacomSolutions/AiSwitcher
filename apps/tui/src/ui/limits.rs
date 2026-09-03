//! Tab 3: per-identity quota windows as gauge bars. Polls slowly; `r` forces
//! a refresh through the endpoint's notify handle.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Style, Stylize};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use crate::app::App;
use crate::models::{LimitResult, OverageInfo};
use crate::timefmt;
use crate::ui::widgets;

const TAB_INDEX: usize = 2;
const BAR_WIDTH: usize = 22;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Limits");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let lines: Vec<Line> = match &app.limits.data {
        Some(data) if data.results.is_empty() => {
            vec![Line::from(
                Span::from("no limit targets configured").dark_gray(),
            )]
        }
        Some(data) => {
            let now_ms = timefmt::now_ms();
            let mut lines = Vec::new();
            for result in &data.results {
                push_result(&mut lines, result, now_ms, app.frame);
            }
            lines
        }
        None => match app.limits.error.as_deref() {
            Some(message) => vec![
                widgets::error_line(message),
                Line::from(Span::from("press r to retry sooner").dark_gray()),
            ],
            None => vec![widgets::loading_line("waiting for /api/limits", app.frame)],
        },
    };

    let visible = usize::from(inner.height);
    widgets::clamp_scroll(&mut app.scrolls[TAB_INDEX], visible, lines.len());
    let offset = u16::try_from(app.scrolls[TAB_INDEX]).unwrap_or(u16::MAX);

    let paragraph = Paragraph::new(Text::from(lines)).scroll((offset, 0));
    f.render_widget(paragraph, inner);
}

fn push_result(lines: &mut Vec<Line<'static>>, result: &LimitResult, now_ms: i64, frame: u64) {
    let identity = result.identity.name().to_string();
    let tool = result.tool_name.clone().unwrap_or_else(|| "?".to_string());
    let status_word = result
        .status
        .clone()
        .unwrap_or_else(|| "pending".to_string());
    let captured = result
        .captured_at
        .as_deref()
        .map(|at| format!(" · {}", timefmt::rel_from_str(at, now_ms)))
        .unwrap_or_default();

    let head = match status_word.as_str() {
        "live" => Line::from(vec![
            Span::from("● ".to_string()).green(),
            Span::from(format!("{tool} · {identity}")).bold(),
            Span::from(format!("  live{captured}")).green(),
        ]),
        "cached" => Line::from(vec![
            Span::from("○ ".to_string()).cyan(),
            Span::from(format!("{tool} · {identity}")).bold(),
            Span::from(format!("  cached{captured}")).cyan(),
        ]),
        "unavailable" => Line::from(vec![
            Span::from("✗ ".to_string()).red(),
            Span::from(format!("{tool} · {identity}")).bold(),
            Span::from("  unavailable").red(),
        ]),
        _ => Line::from(vec![
            Span::from(format!("{} ", widgets::spinner(frame))).yellow(),
            Span::from(format!("{tool} · {identity}")).bold(),
            Span::from(format!("  {status_word}")).yellow(),
        ]),
    };
    lines.push(head);

    if let Some(error) = &result.error {
        lines.push(Line::from(Span::from(format!("   {error}")).red()));
    }
    for window in &result.windows {
        lines.push(window_line(window));
    }
    if let Some(overage) = &result.overage {
        lines.push(overage_line(overage));
    }
    lines.push(Line::default()); // blank separator between results
}

fn window_line(window: &crate::models::LimitWindow) -> Line<'static> {
    let label = widgets::ellipsize(window.label.as_deref().unwrap_or("?"), 18);
    let pct = window.used_percent.unwrap_or(0.0);
    let bar = widgets::gauge(pct, BAR_WIDTH);
    let color = widgets::pct_color(pct);

    let mut detail_parts: Vec<String> = Vec::new();
    if let Some(resets) = &window.resets_at {
        detail_parts.push(resets.clone());
    }
    if let Some(note) = &window.note {
        detail_parts.push(note.clone());
    }
    let detail = if detail_parts.is_empty() {
        String::new()
    } else {
        format!("  {}", detail_parts.join(" · "))
    };

    Line::from(vec![
        Span::from(format!("   {label:<18}")),
        Span::from(bar).fg(color),
        Span::from(format!(" {:>3.0}%", pct)).fg(color),
        Span::from(detail).dark_gray(),
    ])
}

fn overage_line(overage: &OverageInfo) -> Line<'static> {
    let label = overage
        .label
        .clone()
        .unwrap_or_else(|| "overage active".to_string());
    let mut text = format!("   overage: {label}");
    if let Some(spent) = overage.spent_usd {
        text.push_str(&format!(" {}", widgets::money(spent)));
        if let Some(limit) = overage.limit_usd {
            text.push_str(&format!(" of {}", widgets::money(limit)));
        }
    }
    let style = if overage.active.unwrap_or(false) {
        Style::new().yellow()
    } else {
        Style::new().dark_gray()
    };
    Line::from(Span::from(text).style(style))
}
