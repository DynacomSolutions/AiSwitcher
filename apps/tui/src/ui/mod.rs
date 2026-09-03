//! Top-level layout: header, tab bar, unreachable banner, content, footer.

mod auth;
mod help;
mod identities;
mod limits;
mod sessions;
mod status;
mod usage;

pub mod widgets;

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout};
use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Paragraph};

use crate::app::{App, TAB_NAMES};
use crate::timefmt;
use crate::ui::widgets as w;

pub fn draw(f: &mut Frame<'_>, app: &mut App) {
    let area = f.area();
    let banner_rows = u16::from(app.console_down());
    let rows = Layout::vertical([
        Constraint::Length(1),               // header
        Constraint::Length(1),               // tab bar
        Constraint::Length(3 * banner_rows), // console-unreachable banner
        Constraint::Min(0),                  // active tab content
        Constraint::Length(1),               // footer hints
    ])
    .split(area);

    render_header(f, app, rows[0]);
    render_tabs(f, app, rows[1]);
    if app.console_down() {
        render_banner(f, app, rows[2]);
    }
    render_content(f, app, rows[3]);
    render_footer(f, app, rows[4]);
}

fn render_header(f: &mut Frame<'_>, app: &App, area: ratatui::layout::Rect) {
    let version = app
        .status
        .data
        .as_ref()
        .and_then(|status| status.version.clone())
        .unwrap_or_else(|| "?".to_string());
    let dot = if app.console_down() {
        Span::from("●").red()
    } else {
        Span::from("●").green()
    };
    let left = vec![
        Span::from("aistui").bold().cyan(),
        Span::from(format!("  ais {version} ")).dark_gray(),
    ];
    let right = vec![
        Span::from(timefmt::clock_now()).dark_gray(),
        Span::from("  "),
        dot,
        Span::from(" "),
    ];
    let line = w::spaced_line(left, right, usize::from(area.width));
    f.render_widget(Paragraph::new(Text::from(line)), area);
}

fn render_tabs(f: &mut Frame<'_>, app: &App, area: ratatui::layout::Rect) {
    let mut spans = vec![Span::raw(" ")];
    for (index, name) in TAB_NAMES.iter().enumerate() {
        let label = format!(" {} {name} ", index + 1);
        let span = if index == app.tab {
            Span::from(label).fg(Color::Black).bg(Color::Cyan).bold()
        } else {
            Span::from(label).dark_gray()
        };
        spans.push(span);
        spans.push(Span::raw(" "));
    }
    f.render_widget(Paragraph::new(Text::from(Line::from(spans))), area);
}

fn render_banner(f: &mut Frame<'_>, app: &App, area: ratatui::layout::Rect) {
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().red());
    let inner = block.inner(area);
    f.render_widget(block, area);

    let message = Line::from(format!(
        "Console unreachable at {} (retrying in {}s)",
        app.base_url,
        app.retry_in_secs()
    ))
    .red()
    .bold()
    .alignment(Alignment::Center);
    f.render_widget(Paragraph::new(Text::from(message)), inner);
}

fn render_content(f: &mut Frame<'_>, app: &mut App, area: ratatui::layout::Rect) {
    match app.tab {
        0 => status::render(f, app, area),
        1 => identities::render(f, app, area),
        2 => limits::render(f, app, area),
        3 => usage::render(f, app, area),
        4 => sessions::render(f, app, area),
        5 => auth::render(f, app, area),
        _ => help::render(f, app, area),
    }
}

fn render_footer(f: &mut Frame<'_>, app: &App, area: ratatui::layout::Rect) {
    let specific: &[&str] = match app.tab {
        0 => &["auto 3s"],
        1 => &["read-only: edits via web UI or ais CLI"],
        2 => &["r force refresh", "auto 60s"],
        3 => &["auto 60s"],
        4 => &["j/k scroll", "PgUp/PgDn page"],
        5 => &["read-only: fixes via web UI or ais CLI"],
        _ => &[],
    };

    let mut spans: Vec<Span> = Vec::new();
    for hint in specific {
        spans.push(Span::from((*hint).to_string()).dark_gray());
        spans.push(Span::from(" · ").dark_gray());
    }
    spans.push(Span::from("Tab switch").dark_gray());
    spans.push(Span::from(" · ").dark_gray());
    spans.push(Span::from("q quit").dark_gray());

    f.render_widget(Paragraph::new(Text::from(Line::from(spans))), area);
}
