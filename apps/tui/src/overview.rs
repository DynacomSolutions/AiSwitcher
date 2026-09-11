//! Compact single-screen overview for the `ais herdr` tmux wrapper's right
//! panel (`aistui --overview`): every identity's estimated cost, limit
//! windows and next reset, laid out responsively for a narrow side panel,
//! with the identities whose herdr panes are open on the wrapper's left
//! highlighted (the focused pane's identity most strongly).
//!
//! Deliberately separate from app.rs's tabbed dashboard: this screen owns a
//! smaller polling set (limits, usage, herdr bridge, spend guard) and a
//! layout whose only input is the panel's current size. Everything that
//! shapes the screen is pure and unit-tested below.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::DefaultTerminal;
use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout};
use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Paragraph};
use tokio::sync::{Notify, mpsc};

use crate::api::{ApiError, ConsoleClient};
use crate::app::FetchState;
use crate::config::Settings;
use crate::models;
use crate::ui::widgets;

/* ------------------------- wrapper environment contract -------------------- */

/// Presentation overrides the `ais herdr` wrapper passes through the tmux
/// pane environment. All optional; the bare `aistui --overview` default is
/// a local console with bridge highlighting on.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OverviewEnv {
    /// Dim note line under the header: an honest degradation notice from
    /// the wrapper (e.g. the remote has no reachable ais console).
    pub note: Option<String>,
    /// `AIS_OVERVIEW_BRIDGE=off` disables bridge polling entirely: the
    /// panes on screen belong to a different machine than the console
    /// answers for, so highlighting from it would be fabricated.
    pub bridge_on: bool,
    /// Short label shown at the header's right (e.g. "remote:box").
    pub label: Option<String>,
}

impl OverviewEnv {
    pub fn from_env() -> Self {
        let note = std::env::var("AIS_OVERVIEW_NOTE")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let bridge_on = std::env::var("AIS_OVERVIEW_BRIDGE").ok().as_deref() != Some("off");
        let label = std::env::var("AIS_OVERVIEW_LABEL")
            .ok()
            .filter(|v| !v.trim().is_empty());
        Self {
            note,
            bridge_on,
            label,
        }
    }
}

/* --------------------------------- polling --------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    Limits,
    Usage,
    Bridge,
    Spend,
}

impl Endpoint {
    const fn interval(self) -> Duration {
        match self {
            // Focus changes must reach the panel quickly; the bridge DTO is
            // a cheap local read.
            Self::Bridge => Duration::from_secs(5),
            Self::Spend => Duration::from_secs(60),
            // The console itself caches both scans for 45s (docs/API.md).
            Self::Limits | Self::Usage => Duration::from_secs(60),
        }
    }

    /// Whole-request ceilings that outlast the console's server-side scan
    /// budgets (45s limits, 60s usage) so a cold-cache poll is waited out.
    const fn timeout(self) -> Duration {
        match self {
            Self::Limits => Duration::from_secs(50),
            Self::Usage => Duration::from_secs(70),
            _ => Duration::from_secs(20),
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Limits => "/api/limits",
            Self::Usage => "/api/usage",
            Self::Bridge => "/api/herdr-bridge",
            Self::Spend => "/api/spend-guard",
        }
    }
}

enum Msg {
    Limits(Result<models::LimitsResponse, ApiError>),
    Usage(Result<models::UsageResponse, ApiError>),
    Bridge(Result<models::HerdrBridgeResponse, ApiError>),
    Spend(Result<models::SpendGuardResponse, ApiError>),
}

async fn fetch_loop(
    client: Arc<ConsoleClient>,
    endpoint: Endpoint,
    tx: mpsc::UnboundedSender<Msg>,
    notify: Arc<Notify>,
) {
    let mut ticker = tokio::time::interval(endpoint.interval());
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = notify.notified() => {}
        }
        let msg = match endpoint {
            Endpoint::Limits => {
                Msg::Limits(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Usage => {
                Msg::Usage(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Bridge => {
                Msg::Bridge(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Spend => {
                Msg::Spend(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
        };
        if tx.send(msg).is_err() {
            return; // main loop gone: nothing left to feed
        }
    }
}

/* ------------------------------ pure data model ---------------------------- */

/// Highlight level for an identity in the overview list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Highlight {
    #[default]
    None,
    /// At least one open herdr pane maps to this identity.
    Open,
    /// herdr's currently focused pane maps to this identity.
    Focused,
}

/// One identity's merged overview row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IdentityOverview {
    pub name: String,
    /// Tokscale token-estimate cost summed across every provider reporting
    /// for this identity (never real spend).
    pub est_cost: Option<f64>,
    pub session: Option<f64>,
    pub week: Option<f64>,
    pub month: Option<f64>,
    /// The worst window's own reset text, pre-formatted by the adapters.
    pub reset: Option<String>,
    /// A spend-guard breach covers this identity's AWS account.
    pub breach: bool,
    pub highlight: Highlight,
}

impl IdentityOverview {
    /// The single worst window across the merged categories as
    /// (letter, percent); drives the compact and pure-bar layouts.
    pub fn worst_window(&self) -> Option<(char, f64)> {
        let mut best: Option<(char, f64)> = None;
        for (letter, value) in [('s', self.session), ('w', self.week), ('m', self.month)] {
            if let Some(value) = value
                && best.is_none_or(|(_, best_value)| value > best_value)
            {
                best = Some((letter, value));
            }
        }
        best
    }
}

/// Which pane a highlight match came from; identity matches are the real
/// signal, the herdr agent label is the documented degradation path.
fn pane_matches(pane: &models::HerdrBridgePane, identity: &str) -> bool {
    pane.identity.as_deref() == Some(identity) || pane.agent.as_deref() == Some(identity)
}

/// Highlight level for one identity given the bridge's attributed panes.
/// A focused match wins immediately; otherwise any match counts as open.
/// Without a bridge there is nothing to match (the caller renders the
/// honest "no highlight source" note instead of faking one).
pub fn highlight_for_identity(panes: &[models::HerdrBridgePane], identity: &str) -> Highlight {
    let mut open = false;
    for pane in panes {
        if !pane_matches(pane, identity) {
            continue;
        }
        if pane.focused == Some(true) {
            return Highlight::Focused;
        }
        open = true;
    }
    if open {
        Highlight::Open
    } else {
        Highlight::None
    }
}

/// Identities covered by a spend-guard breach (union over breached accounts).
pub fn breached_identities(response: &models::SpendGuardResponse) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for account in &response.accounts {
        if account.breached == Some(true) {
            out.extend(account.identities.iter().cloned());
        }
    }
    out
}

/// Build the overview rows from whichever payloads have arrived. Ordering
/// is alphabetical by identity so a refresh never reshuffles rows the user
/// is reading. Either endpoint may be empty or absent (still loading):
/// rows degrade to what is actually known.
pub fn build_rows(
    limits: &models::LimitsResponse,
    usage: &models::UsageResponse,
    bridge: Option<&models::HerdrBridgeResponse>,
    breached: &BTreeSet<String>,
) -> Vec<IdentityOverview> {
    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut limit_rows: BTreeMap<&str, Vec<&models::LimitResult>> = BTreeMap::new();
    for result in &limits.results {
        names.insert(result.identity.name().to_string());
        limit_rows
            .entry(result.identity.name())
            .or_default()
            .push(result);
    }
    let mut costs: BTreeMap<&str, f64> = BTreeMap::new();
    for result in &usage.results {
        names.insert(result.identity.name().to_string());
        if let Some(cost) = result.report.as_ref().and_then(|report| report.total_cost) {
            *costs.entry(result.identity.name()).or_default() += cost;
        }
    }

    let panes = bridge
        .map(|response| response.panes.as_slice())
        .unwrap_or(&[]);
    names
        .into_iter()
        .map(|name| {
            let results = limit_rows.get(name.as_str()).cloned().unwrap_or_default();
            let (session, week, month, reset) = merge_windows(&results);
            IdentityOverview {
                highlight: highlight_for_identity(panes, &name),
                breach: breached.contains(&name),
                est_cost: costs.get(name.as_str()).copied(),
                name,
                session,
                week,
                month,
                reset,
            }
        })
        .collect()
}

/// Worst (max) window percent per category across every provider reporting
/// for one identity, plus the reset text of the single worst window. This
/// mirrors the bridge's own rule: the sidebar shows the window that would
/// block the session, not a friendly average.
fn merge_windows(
    results: &[&models::LimitResult],
) -> (Option<f64>, Option<f64>, Option<f64>, Option<String>) {
    let mut session: Option<f64> = None;
    let mut week: Option<f64> = None;
    let mut month: Option<f64> = None;
    let mut worst: Option<(f64, String)> = None;
    for result in results {
        for window in &result.windows {
            let Some(pct) = window.used_percent else {
                continue;
            };
            for (category, slot) in [
                ("session", &mut session),
                ("week", &mut week),
                ("month", &mut month),
            ] {
                if window.label.as_deref() == Some(category)
                    && slot.is_none_or(|current| pct > current)
                {
                    *slot = Some(pct);
                }
            }
            if worst.as_ref().is_none_or(|(worst_pct, _)| pct > *worst_pct) {
                worst = Some((pct, window.resets_at.clone().unwrap_or_default()));
            }
        }
    }
    let reset = worst.and_then(|(_, text)| (!text.is_empty()).then_some(text));
    (session, week, month, reset)
}

/* -------------------------------- rendering -------------------------------- */

/// Layout breakpoint for a given panel width in terminal cells. The
/// nominal wrapper panel is 38-44 columns (full mode); below 30 labels
/// shrink to single letters, below 22 the layout degrades to one bar per
/// identity with no labels at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Name + cost line, labelled session/week(/month) bars, reset text.
    Full,
    /// Name + cost line plus one worst-window bar with a single-letter
    /// label.
    Compact,
    /// One bar per identity: marker, worst window, percent. No text labels.
    Bars,
}

pub fn mode_for_width(width: usize) -> Mode {
    if width >= 30 {
        Mode::Full
    } else if width >= 22 {
        Mode::Compact
    } else {
        Mode::Bars
    }
}

/// Compact USD for a narrow panel: 3800 -> "$3.8k", 4_000_000 -> "$4M",
/// 12.34 -> "$12.34".
pub fn compact_money(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1.0e6 {
        return trim_tenth(format!("${:.1}M", value / 1.0e6));
    }
    if abs >= 1.0e3 {
        return trim_tenth(format!("${:.1}k", value / 1.0e3));
    }
    format!("${value:.2}")
}

fn trim_tenth(formatted: String) -> String {
    // "$4.0k" -> "$4k": only an exact ".0" tenth is trimmed.
    if let Some(stripped) = formatted.strip_suffix(".0k") {
        return format!("{stripped}k");
    }
    if let Some(stripped) = formatted.strip_suffix(".0M") {
        return format!("{stripped}M");
    }
    formatted
}

/// Marker cell for one identity: filled dot when a herdr pane maps to it
/// (yellow when that pane is focused, cyan otherwise), hollow dot when not.
pub fn highlight_marker(highlight: Highlight) -> (&'static str, Color) {
    match highlight {
        Highlight::Focused => ("●", Color::Yellow),
        Highlight::Open => ("●", Color::Cyan),
        Highlight::None => ("○", Color::DarkGray),
    }
}

/// The lines for one identity at the given width. Always fits within
/// `width` cells; the split into 1 or 2 lines follows the mode.
pub fn identity_lines(row: &IdentityOverview, mode: Mode, width: usize) -> Vec<Line<'static>> {
    match mode {
        Mode::Full => full_lines(row, width),
        Mode::Compact => compact_lines(row, width),
        Mode::Bars => vec![bars_line(row, width)],
    }
}

fn name_style(row: &IdentityOverview) -> Style {
    if row.breach {
        Style::new().red().bold()
    } else {
        Style::new().bold()
    }
}

fn marker_span(row: &IdentityOverview) -> Span<'static> {
    let (glyph, color) = highlight_marker(row.highlight);
    Span::from(glyph.to_string()).fg(color)
}

fn cost_text(row: &IdentityOverview) -> String {
    row.est_cost
        .map(compact_money)
        .unwrap_or_else(|| "-".to_string())
}

fn full_lines(row: &IdentityOverview, width: usize) -> Vec<Line<'static>> {
    let cost = cost_text(row);
    let name_budget = width.saturating_sub(cost.chars().count() + 4).max(4);
    let mut head = vec![
        marker_span(row),
        Span::from(" "),
        Span::from(widgets::ellipsize(&row.name, name_budget)).style(name_style(row)),
    ];
    if row.breach {
        head.push(Span::from(" ⚠").red().bold());
    }
    // The reserved extra cell keeps the cost from gluing onto the name or
    // the breach marker when the panel leaves no padding.
    let pad =
        width.saturating_sub(head.iter().map(span_width).sum::<usize>() + cost.chars().count() + 1);
    head.push(Span::from(" ".repeat(pad)));
    head.push(Span::from(format!(" {cost}")).dark_gray());

    let categories: Vec<(char, f64)> = [('s', row.session), ('w', row.week), ('m', row.month)]
        .into_iter()
        .filter_map(|(letter, value)| value.map(|value| (letter, value)))
        .collect();
    let mut line2: Vec<Span<'static>> = Vec::new();
    if categories.is_empty() {
        line2.push(Span::from("  no window data").dark_gray());
    } else {
        // Each group costs letter(1) + space(1) + bar + space(1) + pct(5);
        // groups are separated by two spaces, indented by two. The budget
        // reserves the indent and all gaps, so the row always fits. When
        // three groups cannot fit with a usable (>=4 cell) bar each, the
        // lowest-priority categories (month, then week) drop: session and
        // week are the windows that usually block.
        let mut groups = categories;
        while groups.len() > 2 {
            let budget = width.saturating_sub(4 + 2 * (groups.len() - 1));
            if budget / groups.len() >= 12 {
                break;
            }
            groups.pop();
        }
        let count = groups.len();
        let budget = width.saturating_sub(4 + 2 * count.saturating_sub(1));
        let bar_width = (budget / count).saturating_sub(8).clamp(4, 16);
        line2.push(Span::from("  "));
        for (index, (letter, pct)) in groups.iter().enumerate() {
            if index > 0 {
                line2.push(Span::from("  "));
            }
            let color = widgets::pct_color(*pct);
            line2.push(Span::from(format!("{letter} ")).dark_gray());
            line2.push(Span::from(widgets::gauge(*pct, bar_width)).fg(color));
            line2.push(Span::from(format!(" {pct:>3.0}%")).fg(color));
        }
        let used: usize = line2.iter().map(span_width).sum();
        if let Some(reset) = &row.reset {
            let remaining = width.saturating_sub(used + 3);
            if remaining >= 3 {
                let text = widgets::ellipsize(reset, remaining.min(24));
                line2.push(Span::from(format!(" · {text}")).dark_gray());
            }
        }
        // Trim any overshoot defensively (clamped bar minimums at the
        // smallest full-mode widths).
        let mut used: usize = line2.iter().map(span_width).sum();
        while used > width && line2.len() > 1 {
            let removed = line2.pop().map(|span| span_width(&span)).unwrap_or(0);
            used = used.saturating_sub(removed);
        }
    }
    vec![Line::from(head), Line::from(line2)]
}

fn compact_lines(row: &IdentityOverview, width: usize) -> Vec<Line<'static>> {
    let cost = cost_text(row);
    let name_budget = width.saturating_sub(cost.chars().count() + 4).max(4);
    let mut head = vec![
        marker_span(row),
        Span::from(" "),
        Span::from(widgets::ellipsize(&row.name, name_budget)).style(name_style(row)),
    ];
    if row.breach {
        head.push(Span::from(" ⚠").red().bold());
    }
    // The reserved extra cell keeps the cost from gluing onto the name or
    // the breach marker when the panel leaves no padding.
    let pad =
        width.saturating_sub(head.iter().map(span_width).sum::<usize>() + cost.chars().count() + 1);
    head.push(Span::from(" ".repeat(pad)));
    head.push(Span::from(format!(" {cost}")).dark_gray());

    let mut line2: Vec<Span<'static>> = match row.worst_window() {
        Some((letter, pct)) => {
            // letter(1) + space(1) + bar + space(1) + pct(5), indented 2.
            let bar_width = width.saturating_sub(10).clamp(4, 24);
            let color = widgets::pct_color(pct);
            vec![
                Span::from("  "),
                Span::from(format!("{letter} ")).dark_gray(),
                Span::from(widgets::gauge(pct, bar_width)).fg(color),
                Span::from(format!(" {pct:>3.0}%")).fg(color),
            ]
        }
        None => vec![Span::from("  no window data").dark_gray()],
    };
    // Trim any overshoot defensively (rounding at very small widths).
    let mut used: usize = line2.iter().map(span_width).sum();
    while used > width && line2.len() > 1 {
        let removed = line2.pop().map(|span| span_width(&span)).unwrap_or(0);
        used = used.saturating_sub(removed);
    }
    vec![Line::from(head), Line::from(line2)]
}

fn bars_line(row: &IdentityOverview, width: usize) -> Line<'static> {
    // Pure-bar mode: marker + worst bar + percent, no text labels.
    let bar_width = width.saturating_sub(7).clamp(2, 40);
    let mut spans = vec![marker_span(row), Span::from(" ")];
    match row.worst_window() {
        Some((_, pct)) => {
            let color = widgets::pct_color(pct);
            spans.push(Span::from(widgets::gauge(pct, bar_width)).fg(color));
            spans.push(Span::from(format!(" {pct:>3.0}%")).fg(color));
        }
        None => spans.push(Span::from("no data").dark_gray()),
    }
    Line::from(spans)
}

fn span_width(span: &Span<'_>) -> usize {
    span.content.chars().count()
}

/// Honest bridge-source note shown above the list when highlighting cannot
/// be trusted; None when the bridge is on and healthy.
fn bridge_note(app: &OverviewApp) -> Option<String> {
    if !app.env.bridge_on {
        return Some("no highlight source: herdr panes not visible from this console".to_string());
    }
    if let Some(error) = &app.bridge.error {
        return Some(format!("no highlight source: bridge unreachable ({error})"));
    }
    let data = app.bridge.data.as_ref()?;
    let state = data.state.clone().unwrap_or_else(|| "unknown".to_string());
    if state == "active" {
        None
    } else {
        Some(format!("no highlight source: herdr bridge {state}"))
    }
}

fn overview_body(app: &OverviewApp, width: usize) -> Vec<Line<'static>> {
    let mode = mode_for_width(width);
    match (&app.limits.data, &app.usage.data) {
        (Some(limits), Some(usage)) => {
            let breached = app
                .spend
                .data
                .as_ref()
                .map(breached_identities)
                .unwrap_or_default();
            let rows = build_rows(limits, usage, app.bridge.data.as_ref(), &breached);
            if rows.is_empty() {
                return vec![Line::from(
                    Span::from("no identities reported yet").dark_gray(),
                )];
            }
            let mut lines = Vec::new();
            for row in &rows {
                lines.extend(identity_lines(row, mode, width));
                lines.push(Line::default());
            }
            lines
        }
        (None, _) | (_, None) => match (&app.limits.error, &app.usage.error) {
            (Some(error), _) | (_, Some(error)) => vec![widgets::error_line(error)],
            _ => vec![widgets::loading_line("waiting for the console", app.frame)],
        },
    }
}

fn legend_line(app: &OverviewApp) -> Line<'static> {
    let mut spans = vec![
        Span::from("●").cyan(),
        Span::from(" open   ").dark_gray(),
        Span::from("●").yellow(),
        Span::from(" focused   ").dark_gray(),
        Span::from("⚠").red(),
        Span::from(" breach   ").dark_gray(),
    ];
    spans.push(Span::from("q quit").dark_gray());
    let _ = app;
    Line::from(spans)
}

/* ------------------------------- application ------------------------------- */

pub struct OverviewApp {
    pub base_url: String,
    pub env: OverviewEnv,
    pub limits: FetchState<models::LimitsResponse>,
    pub usage: FetchState<models::UsageResponse>,
    pub bridge: FetchState<models::HerdrBridgeResponse>,
    pub spend: FetchState<models::SpendGuardResponse>,
    /// When the most recent completed fetch failed: the instant its
    /// endpoint polls again (drives the unreachable banner countdown).
    next_retry: Option<Instant>,
    pub scroll: usize,
    pub frame: u64,
    pub quitting: bool,
}

impl OverviewApp {
    fn new(settings: &Settings, env: OverviewEnv) -> Self {
        Self {
            base_url: settings.base_url.clone(),
            env,
            limits: FetchState::default(),
            usage: FetchState::default(),
            bridge: FetchState::default(),
            spend: FetchState::default(),
            next_retry: None,
            scroll: 0,
            frame: 0,
            quitting: false,
        }
    }

    fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Limits(result) => {
                let ok = self.limits.record(result);
                self.finish(Endpoint::Limits, ok);
            }
            Msg::Usage(result) => {
                let ok = self.usage.record(result);
                self.finish(Endpoint::Usage, ok);
            }
            Msg::Bridge(result) => {
                let ok = self.bridge.record(result);
                self.finish(Endpoint::Bridge, ok);
            }
            Msg::Spend(result) => {
                let ok = self.spend.record(result);
                self.finish(Endpoint::Spend, ok);
            }
        }
    }

    fn finish(&mut self, endpoint: Endpoint, ok: bool) {
        self.next_retry = if ok {
            None
        } else {
            Some(Instant::now() + endpoint.interval())
        };
    }

    fn console_down(&self) -> bool {
        self.next_retry.is_some()
    }

    /// Whole seconds until the next retry against a console that just
    /// failed, minimum 1 so the banner never shows "(retrying in 0s)".
    fn retry_in_secs(&self) -> u64 {
        self.next_retry
            .and_then(|at| at.checked_duration_since(Instant::now()))
            .map(|d| d.as_secs_f64().ceil() as u64)
            .unwrap_or(0)
            .max(1)
    }
}

fn endpoints_for(env: &OverviewEnv) -> Vec<Endpoint> {
    let mut endpoints = vec![Endpoint::Limits, Endpoint::Usage];
    if env.bridge_on {
        endpoints.push(Endpoint::Bridge);
    }
    endpoints.push(Endpoint::Spend);
    endpoints
}

fn handle_key(app: &mut OverviewApp, key: KeyEvent, notifies: &[Arc<Notify>]) {
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => app.quitting = true,
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quitting = true,
        KeyCode::Char('r') => {
            for notify in notifies {
                notify.notify_one();
            }
        }
        KeyCode::Down | KeyCode::Char('j') => app.scroll = app.scroll.saturating_add(1),
        KeyCode::Up | KeyCode::Char('k') => app.scroll = app.scroll.saturating_sub(1),
        _ => {}
    }
}

pub fn draw(f: &mut Frame<'_>, app: &mut OverviewApp) {
    let area = f.area();
    let note_rows = usize::from(app.env.note.is_some());
    let banner_rows = 3 * u16::from(app.console_down());
    let rows = Layout::vertical([
        Constraint::Length(1),                                            // header
        Constraint::Length(u16::try_from(note_rows).unwrap_or(u16::MAX)), // wrapper note
        Constraint::Length(banner_rows), // console-unreachable banner
        Constraint::Min(0),              // identity list
        Constraint::Length(1),           // legend + hints
    ])
    .split(area);

    render_header(f, app, rows[0]);
    if let Some(note) = app.env.note.clone() {
        let paragraph = Paragraph::new(Text::from(Line::from(format!(" {note}")).yellow()));
        f.render_widget(paragraph, rows[1]);
    }
    if app.console_down() {
        render_banner(f, app, rows[2]);
    }
    render_body(f, app, rows[3]);
    f.render_widget(Paragraph::new(Text::from(legend_line(app))), rows[4]);
}

fn render_header(f: &mut Frame<'_>, app: &OverviewApp, area: ratatui::layout::Rect) {
    let count = app
        .limits
        .data
        .as_ref()
        .map(|data| data.results.len())
        .unwrap_or(0);
    let dot = if app.console_down() {
        Span::from("●").red()
    } else {
        Span::from("●").green()
    };
    let mut left = vec![
        Span::from("ais overview").bold().cyan(),
        Span::from(format!("  {count} identities")).dark_gray(),
    ];
    if let Some(label) = app.env.label.clone() {
        left.push(Span::from(format!("  {label}")).cyan());
    }
    let right = vec![
        Span::from(crate::timefmt::clock_now()).dark_gray(),
        Span::from("  "),
        dot.clone(),
        Span::from(" "),
    ];
    let width = usize::from(area.width);
    let used = |left: &Vec<Span>, right: &Vec<Span>| {
        left.iter()
            .chain(right.iter())
            .map(|s| s.content.chars().count())
            .sum::<usize>()
    };
    // A narrow panel cannot always hold everything; drop the clock first,
    // then the identity count, and never let the halves glue together.
    let right = if used(&left, &right) > width {
        vec![Span::from(" "), dot.clone(), Span::from(" ")]
    } else {
        right
    };
    let left = if used(&left, &right) > width {
        vec![Span::from("ais overview").bold().cyan()]
    } else {
        left
    };
    let line = widgets::spaced_line(left, right, width);
    f.render_widget(Paragraph::new(Text::from(line)), area);
}

fn render_banner(f: &mut Frame<'_>, app: &OverviewApp, area: ratatui::layout::Rect) {
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

fn render_body(f: &mut Frame<'_>, app: &mut OverviewApp, area: ratatui::layout::Rect) {
    let width = usize::from(area.width);
    let mut lines = Vec::new();
    if let Some(note) = bridge_note(app) {
        lines.push(Line::from(Span::from(note).dark_gray()));
        lines.push(Line::default());
    }
    lines.extend(overview_body(app, width));

    let visible = usize::from(area.height);
    widgets::clamp_scroll(&mut app.scroll, visible, lines.len());
    let offset = u16::try_from(app.scroll).unwrap_or(u16::MAX);
    let paragraph = Paragraph::new(Text::from(lines)).scroll((offset, 0));
    f.render_widget(paragraph, area);
}

/// Entry point for `aistui --overview`. Same lifecycle guarantees as the
/// tabbed dashboard: raw mode + panic hook from the caller, terminal
/// restored unconditionally in main().
pub async fn run(mut terminal: DefaultTerminal, settings: Settings) -> Result<()> {
    let env = OverviewEnv::from_env();
    let client =
        Arc::new(ConsoleClient::new(settings.clone()).context("failed to build HTTP client")?);

    let endpoints = endpoints_for(&env);
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<Msg>();
    let notifies: Vec<Arc<Notify>> = endpoints.iter().map(|_| Arc::new(Notify::new())).collect();
    for (index, endpoint) in endpoints.iter().enumerate() {
        tokio::spawn(fetch_loop(
            Arc::clone(&client),
            *endpoint,
            msg_tx.clone(),
            Arc::clone(&notifies[index]),
        ));
    }

    // Blocking reader thread bridged into the async world; it dies with the
    // process, which is fine since nothing else uses the terminal by then.
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Event>();
    std::thread::spawn(move || {
        while let Ok(event) = crossterm::event::read() {
            if event_tx.send(event).is_err() {
                break;
            }
        }
    });

    let mut app = OverviewApp::new(&settings, env);
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    loop {
        tokio::select! {
            maybe = msg_rx.recv() => match maybe {
                Some(msg) => app.apply(msg),
                None => break,
            },
            maybe = event_rx.recv() => match maybe {
                Some(event) => {
                    if let Event::Key(key) = event
                        && key.kind == KeyEventKind::Press
                    {
                        handle_key(&mut app, key, &notifies);
                    }
                }
                None => break,
            },
            _ = ticker.tick() => app.frame = app.frame.wrapping_add(1),
        }
        if app.quitting {
            break;
        }
        terminal
            .draw(|frame| draw(frame, &mut app))
            .context("failed to draw frame")?;
    }
    Ok(())
}

/* ---------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        HerdrBridgePane, HerdrBridgeResponse, IdentityRef, LimitResult, LimitWindow,
        SpendGuardAccount, SpendGuardResponse, TokscaleReport, UsageResult,
    };

    fn limit_result(identity: &str, windows: Vec<(&str, f64, Option<&str>)>) -> LimitResult {
        LimitResult {
            tool_name: None,
            provider: Some("anthropic".to_string()),
            identity: IdentityRef {
                name: Some(identity.to_string()),
            },
            windows: windows
                .into_iter()
                .map(|(label, pct, reset)| LimitWindow {
                    label: Some(label.to_string()),
                    used_percent: Some(pct),
                    resets_at: reset.map(str::to_string),
                    note: None,
                })
                .collect(),
            status: Some("live".to_string()),
            error: None,
            captured_at: None,
            overage: None,
            manual_reset: None,
        }
    }

    fn usage_result(identity: &str, cost: f64) -> UsageResult {
        UsageResult {
            provider: Some("anthropic".to_string()),
            identity: IdentityRef {
                name: Some(identity.to_string()),
            },
            report: Some(TokscaleReport {
                total_cost: Some(cost),
                ..Default::default()
            }),
            error: None,
            extra_cost: None,
            real_cost: None,
            date_span: None,
        }
    }

    fn pane(identity: Option<&str>, agent: Option<&str>, focused: bool) -> HerdrBridgePane {
        HerdrBridgePane {
            agent: agent.map(str::to_string),
            focused: Some(focused),
            identity: identity.map(str::to_string),
        }
    }

    #[test]
    fn compact_money_scales_for_narrow_panels() {
        assert_eq!(compact_money(0.0), "$0.00");
        assert_eq!(compact_money(12.34), "$12.34");
        assert_eq!(compact_money(3_800.0), "$3.8k");
        assert_eq!(compact_money(4_000.0), "$4k");
        assert_eq!(compact_money(1_234_567.0), "$1.2M");
        assert_eq!(compact_money(2_000_000.0), "$2M");
    }

    #[test]
    fn width_breakpoints_match_the_wrapper_panel_range() {
        assert_eq!(mode_for_width(44), Mode::Full);
        assert_eq!(mode_for_width(38), Mode::Full);
        assert_eq!(mode_for_width(30), Mode::Full);
        assert_eq!(mode_for_width(29), Mode::Compact);
        assert_eq!(mode_for_width(22), Mode::Compact);
        assert_eq!(mode_for_width(21), Mode::Bars);
        assert_eq!(mode_for_width(12), Mode::Bars);
    }

    #[test]
    fn highlight_identity_match_with_focused_winning() {
        let panes = vec![
            pane(Some("workco"), Some("codex"), false),
            pane(Some("other"), Some("claude"), false),
        ];
        assert_eq!(highlight_for_identity(&panes, "workco"), Highlight::Open);
        assert_eq!(highlight_for_identity(&panes, "other"), Highlight::Open);
        assert_eq!(highlight_for_identity(&panes, "missing"), Highlight::None);

        let mut focused = panes.clone();
        focused[0].focused = Some(true);
        assert_eq!(
            highlight_for_identity(&focused, "workco"),
            Highlight::Focused
        );
    }

    #[test]
    fn highlight_degrades_to_the_herdr_agent_label() {
        let panes = vec![pane(None, Some("codex"), false)];
        assert_eq!(highlight_for_identity(&panes, "codex"), Highlight::Open);
        assert_eq!(highlight_for_identity(&panes, "workco"), Highlight::None);

        let mut focused = panes.clone();
        focused[0].focused = Some(true);
        assert_eq!(
            highlight_for_identity(&focused, "codex"),
            Highlight::Focused
        );
    }

    #[test]
    fn empty_bridge_highlights_nothing() {
        assert_eq!(highlight_for_identity(&[], "workco"), Highlight::None);
    }

    #[test]
    fn rows_merge_costs_and_worst_windows_per_identity() {
        let limits = models::LimitsResponse {
            results: vec![
                limit_result(
                    "workco",
                    vec![("session", 18.0, Some("Sep 14")), ("week", 42.0, None)],
                ),
                limit_result("workco", vec![("session", 90.0, Some("Sep 15"))]),
                limit_result("personal", vec![("month", 7.0, None)]),
            ],
        };
        let usage = models::UsageResponse {
            results: vec![
                usage_result("workco", 100.0),
                usage_result("workco", 2_700.0),
                usage_result("solo", 4.5),
            ],
        };

        let rows = build_rows(&limits, &usage, None, &BTreeSet::new());
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["personal", "solo", "workco"]);

        let workco = &rows[2];
        assert_eq!(workco.est_cost, Some(2_800.0));
        assert_eq!(workco.session, Some(90.0));
        assert_eq!(workco.week, Some(42.0));
        assert_eq!(workco.month, None);
        assert_eq!(workco.reset.as_deref(), Some("Sep 15"));
        assert_eq!(workco.worst_window(), Some(('s', 90.0)));
    }

    #[test]
    fn spend_guard_breaches_flag_their_identities() {
        let response = SpendGuardResponse {
            accounts: vec![
                SpendGuardAccount {
                    breached: Some(true),
                    identities: vec!["acme-bedrock".to_string()],
                },
                SpendGuardAccount {
                    breached: Some(false),
                    identities: vec!["acme-dev".to_string()],
                },
                SpendGuardAccount {
                    breached: None,
                    identities: vec!["acme-degraded".to_string()],
                },
            ],
        };
        let breached = breached_identities(&response);
        assert!(breached.contains("acme-bedrock"));
        assert!(!breached.contains("acme-dev"));
        assert!(!breached.contains("acme-degraded"));

        let limits = models::LimitsResponse {
            results: vec![limit_result("acme-bedrock", vec![("week", 10.0, None)])],
        };
        let usage = models::UsageResponse { results: vec![] };
        let rows = build_rows(&limits, &usage, None, &breached);
        assert!(rows[0].breach);
    }

    #[test]
    fn bridge_panes_drive_the_highlight_column() {
        let limits = models::LimitsResponse {
            results: vec![
                limit_result("workco", vec![("session", 18.0, None)]),
                limit_result("personal", vec![("session", 3.0, None)]),
            ],
        };
        let usage = models::UsageResponse { results: vec![] };
        let bridge = HerdrBridgeResponse {
            state: Some("active".to_string()),
            panes: vec![pane(Some("workco"), Some("codex"), true)],
        };

        let rows = build_rows(&limits, &usage, Some(&bridge), &BTreeSet::new());
        assert_eq!(rows[0].name, "personal");
        assert_eq!(rows[0].highlight, Highlight::None);
        assert_eq!(rows[1].name, "workco");
        assert_eq!(rows[1].highlight, Highlight::Focused);
    }

    #[test]
    fn full_mode_lines_fit_and_carry_bars_reset_and_cost() {
        let row = IdentityOverview {
            name: "workco".to_string(),
            est_cost: Some(3_800.0),
            session: Some(18.0),
            week: Some(42.0),
            month: None,
            reset: Some("Sep 14, 3:00 PM".to_string()),
            breach: false,
            highlight: Highlight::Open,
        };
        for width in [30, 34, 38, 42, 44, 60] {
            let lines = identity_lines(&row, Mode::Full, width);
            assert_eq!(lines.len(), 2, "full mode renders two lines at {width}");
            for line in &lines {
                let used: usize = line.spans.iter().map(|s| s.content.chars().count()).sum();
                assert!(used <= width, "line overflows {width}: {used}");
            }
            let head = lines[0]
                .spans
                .iter()
                .map(|s| s.content.to_string())
                .collect::<String>();
            assert!(head.contains("workco"), "name visible at {width}: {head:?}");
            assert!(head.contains("$3.8k"), "compact cost visible at {width}");
            let bars = lines[1]
                .spans
                .iter()
                .map(|s| s.content.to_string())
                .collect::<String>();
            assert!(bars.contains('s'), "session label at {width}: {bars:?}");
            assert!(bars.contains('w'), "week label at {width}: {bars:?}");
            assert!(bars.contains("42%"), "week percent at {width}: {bars:?}");
        }
        // The reset text appears only when the bar row leaves room for it:
        // at the nominal 38-44 panel it is dropped (honest responsive
        // degradation), at wider panels it shows in full.
        let narrow = identity_lines(&row, Mode::Full, 44);
        let bars: String = narrow[1]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(
            !bars.contains("Sep 14"),
            "no room for reset at width 44: {bars:?}"
        );
        let wide = identity_lines(&row, Mode::Full, 70);
        let bars: String = wide[1]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(
            bars.contains("Sep 14, 3:00 PM"),
            "reset text at width 70: {bars:?}"
        );
    }

    #[test]
    fn full_mode_marks_breach_and_focus() {
        let mut row = IdentityOverview {
            name: "acme-bedrock".to_string(),
            est_cost: Some(12.0),
            session: Some(100.0),
            week: None,
            month: None,
            reset: None,
            breach: true,
            highlight: Highlight::Focused,
        };
        let lines = identity_lines(&row, Mode::Full, 38);
        let head: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(head.contains("⚠"), "breach marker present: {head:?}");
        let styles: Vec<_> = lines[0].spans.iter().map(|s| s.style).collect();
        assert!(
            styles.iter().any(|s| s.fg == Some(Color::Yellow)),
            "focused marker yellow"
        );
        assert!(
            styles.iter().any(|s| s.fg == Some(Color::Red)),
            "breach name red"
        );

        row.breach = false;
        row.highlight = Highlight::None;
        let lines = identity_lines(&row, Mode::Full, 38);
        let head: String = lines[0]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(!head.contains("⚠"), "no breach marker without a breach");
    }

    #[test]
    fn compact_mode_renders_one_labelled_worst_bar() {
        let row = IdentityOverview {
            name: "workco".to_string(),
            est_cost: Some(3_800.0),
            session: Some(18.0),
            week: Some(42.0),
            month: None,
            reset: Some("Sep 14".to_string()),
            breach: false,
            highlight: Highlight::None,
        };
        for width in [22, 26, 29] {
            let lines = identity_lines(&row, Mode::Compact, width);
            assert_eq!(lines.len(), 2);
            let head: String = lines[0]
                .spans
                .iter()
                .map(|s| s.content.to_string())
                .collect();
            let bars: String = lines[1]
                .spans
                .iter()
                .map(|s| s.content.to_string())
                .collect();
            assert!(head.contains("workco") && head.contains("$3.8k"));
            // The worst window (week, 42%) wins the single bar.
            assert!(
                bars.contains('w'),
                "worst window letter at {width}: {bars:?}"
            );
            assert!(bars.contains("42%"));
            assert!(
                !bars.contains('s'),
                "only one bar in compact mode at {width}"
            );
            for line in [&lines[0], &lines[1]] {
                let used: usize = line.spans.iter().map(|s| s.content.chars().count()).sum();
                assert!(used <= width, "compact line overflows {width}: {used}");
            }
        }
    }

    #[test]
    fn bars_mode_is_a_single_labelless_line() {
        let row = IdentityOverview {
            name: "workco".to_string(),
            est_cost: Some(3_800.0),
            session: Some(18.0),
            week: Some(42.0),
            month: None,
            reset: None,
            breach: false,
            highlight: Highlight::Focused,
        };
        for width in [12, 18, 21] {
            let lines = identity_lines(&row, Mode::Bars, width);
            assert_eq!(lines.len(), 1, "bars mode is one line at {width}");
            let text: String = lines[0]
                .spans
                .iter()
                .map(|s| s.content.to_string())
                .collect();
            assert!(text.contains("42%"), "percent kept at {width}: {text:?}");
            assert!(
                !text.contains('w'),
                "no letters in pure-bar mode at {width}"
            );
            assert!(
                !text.contains("workco"),
                "no name in pure-bar mode at {width}"
            );
            let used: usize = lines[0]
                .spans
                .iter()
                .map(|s| s.content.chars().count())
                .sum();
            assert!(used <= width, "bars line overflows {width}: {used}");
        }
    }

    #[test]
    fn three_bar_groups_drop_month_when_the_panel_is_too_narrow() {
        let row = IdentityOverview {
            name: "workco".to_string(),
            est_cost: Some(1.0),
            session: Some(10.0),
            week: Some(20.0),
            month: Some(30.0),
            ..Default::default()
        };
        let lines = identity_lines(&row, Mode::Full, 30);
        let bars: String = lines[1]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(
            bars.contains('s') && bars.contains('w'),
            "s/w kept at 30: {bars:?}"
        );
        assert!(
            !bars.contains('m'),
            "month drops before bars get cramped at 30: {bars:?}"
        );
        let used: usize = lines[1]
            .spans
            .iter()
            .map(|s| s.content.chars().count())
            .sum();
        assert!(used <= 30, "bar row overflows 30: {used}");
        // Wide panels keep all three categories.
        let wide = identity_lines(&row, Mode::Full, 44);
        let bars: String = wide[1]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(
            bars.contains('m'),
            "all three categories fit at 44: {bars:?}"
        );
    }

    #[test]
    fn windowless_rows_render_honestly_in_every_mode() {
        let row = IdentityOverview {
            name: "solo".to_string(),
            est_cost: None,
            session: None,
            week: None,
            month: None,
            reset: None,
            breach: false,
            highlight: Highlight::None,
        };
        let full = identity_lines(&row, Mode::Full, 38);
        let full_text: String = full[1]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(full_text.contains("no window data"));
        let compact = identity_lines(&row, Mode::Compact, 24);
        let compact_text: String = compact[1]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(compact_text.contains("no window data"));
        let bars = identity_lines(&row, Mode::Bars, 16);
        let bars_text: String = bars[0]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(bars_text.contains("no data"));
        // No cost reported renders as "-", never a fabricated $0.
        let head: String = full[0]
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert!(head.contains('-'));
    }

    #[test]
    fn endpoints_bridge_polling_follows_the_wrapper_switch() {
        let env_on = OverviewEnv {
            note: None,
            bridge_on: true,
            label: None,
        };
        let env_off = OverviewEnv {
            bridge_on: false,
            ..Default::default()
        };
        assert!(endpoints_for(&env_on).contains(&Endpoint::Bridge));
        assert!(!endpoints_for(&env_off).contains(&Endpoint::Bridge));
    }
}
