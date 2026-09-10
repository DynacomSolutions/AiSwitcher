//! Tab 1: status summary, per-identity cost and limits, tool registry and
//! live agent processes.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Style, Stylize};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Cell, Paragraph, Row, Table};

use crate::app::App;
use crate::summary::{self, ProviderSummary, RealSpend};
use crate::timefmt;
use crate::ui::widgets;

const TABLE_HEADER_STYLE: Style = Style::new();
/// Tab 0: the identity panel is the one scrollable section on this tab.
const TAB_INDEX: usize = 0;
const BAR_WIDTH: usize = 10;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(7),
        Constraint::Min(9),
        Constraint::Min(5),
    ])
    .split(area);

    render_summary(f, app, rows[0]);
    render_identities(f, app, rows[1]);
    render_tools(f, app, rows[2]);
    render_processes(f, app, rows[3]);
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

/// Tab 1's headline panel: one row per identity and provider, merging the
/// limits scan (windows, resets, manual reset credits) with the usage scan
/// (estimated token cost, provider-reported real spend). Both endpoints
/// arrive on their own 60s cadence; the panel renders whatever has landed
/// and degrades missing cells to "-".
fn render_identities(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Identity cost and limits");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let limits = app.limits.data.as_ref();
    let usage = app.usage.data.as_ref();

    // Nothing has landed yet: one error or loading line covers the panel.
    if limits.is_none() && usage.is_none() {
        let line = match app.limits.error.as_deref().or(app.usage.error.as_deref()) {
            Some(message) => widgets::error_line(message),
            None => widgets::loading_line("waiting for /api/limits and /api/usage", app.frame),
        };
        f.render_widget(Paragraph::new(Text::from(line)), inner);
        return;
    }

    let header = Row::new([
        "IDENTITY", "PROVIDER", "EST $", "REAL $", "LIMITS", "RESETS", "ERROR",
    ])
    .style(TABLE_HEADER_STYLE.dark_gray().bold());

    let mut body: Vec<Row> = Vec::new();
    for missing in [
        ("limits", limits.is_none(), app.limits.error.as_deref()),
        ("usage", usage.is_none(), app.usage.error.as_deref()),
    ] {
        if let (true, Some(message)) = (missing.1, missing.2) {
            body.push(Row::new([Cell::from(widgets::error_line(message))]));
        }
    }

    let groups = summary::summarize(limits, usage);
    if groups.is_empty() {
        body.push(Row::new([Cell::from(
            Span::from("no identities reporting yet").dark_gray(),
        )]));
    }
    for group in &groups {
        for (index, provider) in group.providers.iter().enumerate() {
            body.push(provider_row(group, provider, index > 0, app.frame));
        }
    }

    let widths = [
        Constraint::Length(16),
        Constraint::Length(15),
        Constraint::Length(10),
        Constraint::Length(13),
        Constraint::Length(16),
        Constraint::Length(30),
        Constraint::Min(8),
    ];
    let visible = usize::from(inner.height).saturating_sub(1);
    widgets::clamp_scroll(&mut app.scrolls[TAB_INDEX], visible, body.len());
    let shown: Vec<Row> = body
        .into_iter()
        .skip(app.scrolls[TAB_INDEX])
        .take(visible)
        .collect();

    let table = Table::new(shown, widths).header(header).column_spacing(2);
    f.render_widget(table, inner);
}

fn provider_row(
    group: &summary::IdentitySummary,
    provider: &ProviderSummary,
    repeat: bool,
    frame: u64,
) -> Row<'static> {
    let identity = if repeat {
        Cell::from(String::new())
    } else {
        Cell::from(Span::from(widgets::ellipsize(&group.identity, 16)).bold())
    };

    let mut provider_spans = vec![provider_glyph(provider.limit_status.as_deref(), frame)];
    provider_spans.push(Span::from(provider_label(&provider.provider)));
    let provider_cell = Cell::from(Line::from(provider_spans));

    let est = match provider.est_cost {
        Some(cost) => Cell::from(widgets::money(cost)).cyan(),
        None => right_dim("-"),
    };

    Row::new(vec![
        identity,
        provider_cell,
        est,
        real_spend_cell(&provider.real),
        limits_cell(provider),
        resets_cell(provider),
        error_cell(provider),
    ])
}

/// Fetch-state glyph matching the limits tab's convention.
fn provider_glyph(status: Option<&str>, frame: u64) -> Span<'static> {
    match status {
        Some("live") => Span::from("● ").green(),
        Some("cached") => Span::from("○ ").cyan(),
        Some("unavailable") => Span::from("✗ ").red(),
        Some(_) => Span::from(format!("{} ", widgets::spinner(frame))).yellow(),
        None => Span::from("  "),
    }
}

fn real_spend_cell(real: &RealSpend) -> Cell<'static> {
    if !real.is_reported() {
        return right_dim("-");
    }
    let text = match (real.usd, real.limit_usd) {
        (Some(spent), Some(limit)) => {
            format!("{}/{}", widgets::money(spent), widgets::money(limit))
        }
        (Some(spent), None) => widgets::money(spent),
        (None, _) => real
            .label
            .clone()
            .map(|label| widgets::ellipsize(&label, 12))
            .unwrap_or_else(|| "-".to_string()),
    };
    let style = if real.active {
        Style::new().yellow()
    } else if real.usd.is_some() {
        Style::new().green()
    } else {
        Style::new().dark_gray()
    };
    Cell::from(Line::from(Span::from(text).style(style)).alignment(Alignment::Right))
}

fn limits_cell(provider: &ProviderSummary) -> Cell<'static> {
    if !provider.has_limit_data() {
        return right_dim("-");
    }
    match provider.worst_percent {
        Some(pct) => {
            let color = widgets::pct_color(pct);
            Cell::from(Line::from(vec![
                Span::from(widgets::gauge(pct, BAR_WIDTH)).fg(color),
                Span::from(format!(" {:>3.0}%", pct)).fg(color),
            ]))
        }
        None => right_dim("n/a"),
    }
}

fn resets_cell(provider: &ProviderSummary) -> Cell<'static> {
    // The scheduled reset is the actionable fact, so it leads; a blocking
    // note (e.g. "credits depleted") and any manual reset credits follow.
    let mut spans: Vec<Span> = Vec::new();
    match provider.next_reset.as_deref() {
        Some(reset) => spans.push(Span::from(widgets::ellipsize(reset, 22)).dark_gray()),
        None => spans.push(Span::from("-").dark_gray()),
    }
    if let Some(note) = provider.note.as_deref() {
        spans.push(Span::from(format!(" · {note}")).yellow());
    }
    if let Some(count) = provider.manual_resets {
        spans.push(
            Span::from(format!(
                " +{count} {}",
                if count == 1 { "reset" } else { "resets" }
            ))
            .yellow(),
        );
    }
    Cell::from(Line::from(spans))
}

fn error_cell(provider: &ProviderSummary) -> Cell<'static> {
    match &provider.error {
        Some(message) => Cell::from(Span::from(widgets::ellipsize(message, 40)).red()),
        None => Cell::from(String::new()),
    }
}

fn right_dim(text: &str) -> Cell<'static> {
    Cell::from(Line::from(Span::from(text.to_string()).dark_gray()).alignment(Alignment::Right))
}

/// Display label mirroring usageProviderLabel for the canonical providers
/// the server emits; unknown ones fall back to "Amazon Bedrock" style
/// title casing.
fn provider_label(provider: &str) -> String {
    match provider {
        "anthropic" => return "Anthropic".to_string(),
        "openai" => return "OpenAI".to_string(),
        "xai" => return "xAI".to_string(),
        "kimi" => return "Kimi".to_string(),
        "zai" => return "Z.ai".to_string(),
        "alibaba" => return "Alibaba".to_string(),
        "opencode-go" => return "OpenCode Go".to_string(),
        "opencode" => return "OpenCode".to_string(),
        _ => {}
    }
    provider
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
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
