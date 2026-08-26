//! Small rendering helpers shared by the tab modules.

use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding};

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn spinner(frame: u64) -> &'static str {
    SPINNER[(frame % SPINNER.len() as u64) as usize]
}

/// Rounded panel with a cyan title and a little breathing room.
pub fn panel(title: &str) -> Block<'_> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .title(format!(" {title} "))
        .title_style(Style::new().cyan().bold())
        .padding(Padding::horizontal(1))
}

/// Coloured check/cross glyph for existence columns.
pub fn check(ok: Option<bool>) -> Span<'static> {
    Span::from(check_text(ok)).style(check_style(ok))
}

/// Plain-text glyph for existence, for callers composing padded lines.
pub fn check_text(ok: Option<bool>) -> &'static str {
    match ok {
        Some(true) => "✓",
        Some(false) => "✗",
        None => "-",
    }
}

fn check_style(ok: Option<bool>) -> Style {
    match ok {
        Some(true) => Style::new().green().bold(),
        Some(false) => Style::new().red().bold(),
        None => Style::new().dark_gray(),
    }
}

/// Threshold colour for used-percent gauges.
pub fn pct_color(pct: f64) -> Color {
    if pct >= 85.0 {
        Color::Red
    } else if pct >= 60.0 {
        Color::Yellow
    } else {
        Color::Green
    }
}

/// Block-character gauge bar, e.g. "██████░░░░".
pub fn gauge(pct: f64, width: usize) -> String {
    let clamped = pct.clamp(0.0, 100.0);
    let filled = ((clamped / 100.0) * width as f64).round() as usize;
    let filled = filled.min(width);
    let mut bar = "█".repeat(filled);
    bar.push_str(&"░".repeat(width - filled));
    bar
}

/// Truncate to `max` characters with an ASCII ellipsis when cut.
pub fn ellipsize(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if text.chars().count() <= max {
        return text.to_string();
    }
    if max <= 3 {
        return text.chars().take(max).collect();
    }
    let head: String = text.chars().take(max - 3).collect();
    format!("{head}...")
}

/// Compact token counts: 1234 -> "1.2k", 5_600_000 -> "5.6M".
pub fn human_count(value: f64) -> String {
    let abs = value.abs();
    let (scaled, suffix) = if abs >= 1.0e12 {
        (value / 1.0e12, "T")
    } else if abs >= 1.0e9 {
        (value / 1.0e9, "B")
    } else if abs >= 1.0e6 {
        (value / 1.0e6, "M")
    } else if abs >= 1.0e3 {
        (value / 1.0e3, "k")
    } else {
        return format!("{}", value.round() as i64);
    };
    trim_zero(format!("{scaled:.1}{suffix}"))
}

fn trim_zero(formatted: String) -> String {
    formatted.replace(".0", "")
}

/// Money formatting that keeps tiny costs visible.
pub fn money(value: f64) -> String {
    if value == 0.0 {
        "$0.00".to_string()
    } else if value.abs() < 0.01 {
        format!("${value:.4}")
    } else {
        format!("${value:.2}")
    }
}

/// Keep a scroll offset within `[0, total - visible]`.
pub fn clamp_scroll(offset: &mut usize, visible: usize, total: usize) {
    *offset = (*offset).min(total.saturating_sub(visible));
}

/// Line with left content and right-aligned content in one row.
pub fn spaced_line<'a>(left: Vec<Span<'a>>, right: Vec<Span<'a>>, width: usize) -> Line<'a> {
    let used: usize = left
        .iter()
        .chain(right.iter())
        .map(|span| span.content.chars().count())
        .sum();
    let pad = width.saturating_sub(used);
    let mut spans = left;
    if pad > 0 {
        spans.push(Span::raw(" ".repeat(pad)));
    }
    spans.extend(right);
    Line::from(spans)
}

/// Dim "waiting" line with a spinner.
pub fn loading_line(label: &str, frame: u64) -> Line<'static> {
    Line::from(vec![
        Span::from(format!("{} ", spinner(frame))).cyan(),
        Span::from(label.to_string()).dark_gray(),
    ])
}

/// Red error line, kept on one visual row.
pub fn error_line(message: &str) -> Line<'static> {
    Line::from(Span::from(ellipsize(message, 400)).red())
}
