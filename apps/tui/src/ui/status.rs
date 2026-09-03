//! Tab 1: status summary, tool registry and live agent processes.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Style, Stylize};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Cell, Paragraph, Row, Table};

use crate::app::App;
use crate::timefmt;
use crate::ui::widgets;

const TABLE_HEADER_STYLE: Style = Style::new();

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(9),
        Constraint::Min(5),
    ])
    .split(area);

    render_summary(f, app, rows[0]);
    render_tools(f, app, rows[1]);
    render_processes(f, app, rows[2]);
}

fn render_summary(f: &mut Frame<'_>, app: &App, area: Rect) {
    let line = match &app.status.data {
        Some(status) => {
            let version = status.version.as_deref().unwrap_or("?");
            let uptime = status
                .uptime_s
                .map(timefmt::human_duration)
                .unwrap_or_else(|| "?".to_string());
            Line::from(vec![
                Span::from("ais ").bold(),
                Span::from(version.to_string()).cyan(),
                Span::from(format!("  up {uptime}")).green(),
                Span::from("  home "),
                Span::from(status.home.clone().unwrap_or_default()).dark_gray(),
                Span::from("  aisHome "),
                Span::from(status.ais_home.clone().unwrap_or_default()).dark_gray(),
            ])
        }
        None if app.status.error.is_some() => {
            widgets::error_line(app.status.error.as_deref().unwrap_or(""))
        }
        None => widgets::loading_line("waiting for /api/status", app.frame),
    };
    f.render_widget(Paragraph::new(Text::from(line)), area);
}

fn placeholder(f: &mut Frame<'_>, inner: Rect, message: Option<&str>, endpoint: &str, frame: u64) {
    let line = match message {
        Some(error) => widgets::error_line(error),
        None => widgets::loading_line(&format!("waiting for {endpoint}"), frame),
    };
    f.render_widget(Paragraph::new(Text::from(line)), inner);
}

fn render_tools(f: &mut Frame<'_>, app: &App, area: Rect) {
    let block = widgets::panel("Tool registry");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let Some(status) = &app.status.data else {
        placeholder(
            f,
            inner,
            app.status.error.as_deref(),
            "/api/status",
            app.frame,
        );
        return;
    };

    let header = Row::new(["TOOL", "REAL BIN", "REG", "BINARY"])
        .style(TABLE_HEADER_STYLE.dark_gray().bold());
    let body: Vec<Row> = status
        .tools
        .iter()
        .map(|tool| {
            let binary = match &tool.binary_path {
                Some(path) => Cell::from(Span::from(path.clone()).dark_gray()),
                None => Cell::from(Span::from("not found").red()),
            };
            Row::new(vec![
                Cell::from(Span::from(tool.tool_name.clone().unwrap_or_default()).bold()),
                Cell::from(tool.real_binary_name.clone().unwrap_or_default()),
                Cell::from(widgets::check(tool.registry_exists)),
                binary,
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(9),
        Constraint::Length(11),
        Constraint::Length(5),
        Constraint::Min(20),
    ];
    let table = Table::new(body, widths).header(header).column_spacing(2);
    f.render_widget(table, inner);
}

fn render_processes(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let title = processes_title(app);
    let block = widgets::panel(&title);
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let Some(data) = &app.processes.data else {
        placeholder(
            f,
            inner,
            app.processes.error.as_deref(),
            "/api/processes",
            app.frame,
        );
        return;
    };
    if data.processes.is_empty() {
        f.render_widget(
            Paragraph::new(Text::from(Line::from(
                Span::from("no agent CLIs running").dark_gray(),
            ))),
            inner,
        );
        return;
    }

    let now_ms = timefmt::now_ms();
    let header = Row::new(["PID", "TOOL", "IDENTITY", "UPTIME", "CWD", "COMMAND"])
        .style(TABLE_HEADER_STYLE.dark_gray().bold());
    let body: Vec<Row> = data
        .processes
        .iter()
        .map(|proc| {
            let uptime = proc
                .started_at
                .as_deref()
                .and_then(timefmt::parse_to_ms)
                .map(|ms| timefmt::human_duration(((now_ms - ms).max(0) / 1000) as u64))
                .unwrap_or_else(|| "-".to_string());
            Row::new(vec![
                Cell::from(proc.pid.map(|pid| pid.to_string()).unwrap_or_default()),
                Cell::from(Span::from(proc.tool.clone().unwrap_or_default()).cyan()),
                Cell::from(
                    proc.identity
                        .clone()
                        .unwrap_or_else(|| "unattributed".to_string()),
                )
                .style(if proc.identity.is_some() {
                    Style::new()
                } else {
                    Style::new().dark_gray()
                }),
                Cell::from(uptime.dark_gray()),
                Cell::from(widgets::ellipsize(proc.cwd.as_deref().unwrap_or("-"), 28)),
                Cell::from(widgets::ellipsize(
                    proc.command.as_deref().unwrap_or("-"),
                    60,
                )),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(8),
        Constraint::Length(8),
        Constraint::Length(14),
        Constraint::Length(11),
        Constraint::Min(16),
        Constraint::Min(12),
    ];
    let table = Table::new(body, widths).header(header).column_spacing(2);
    f.render_widget(table, inner);
}

fn processes_title(app: &App) -> String {
    let scanned = app
        .processes
        .data
        .as_ref()
        .and_then(|data| data.scanned_at.clone())
        .map(|scanned_at| {
            format!(
                " (scanned {})",
                timefmt::rel_from_str(&scanned_at, timefmt::now_ms())
            )
        })
        .unwrap_or_default();
    format!("Live processes{scanned}")
}
