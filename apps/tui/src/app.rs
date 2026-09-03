//! Central application state, the async event loop and per-endpoint fetchers.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::DefaultTerminal;
use tokio::sync::{Notify, mpsc};

use crate::api::{ApiError, ConsoleClient};
use crate::config::Settings;
use crate::models;
use crate::ui;

pub const TAB_COUNT: usize = 7;
pub const TAB_NAMES: [&str; TAB_COUNT] = [
    "Status",
    "Identities",
    "Limits",
    "Usage",
    "Sessions",
    "Auth",
    "Help",
];

/// Polling intervals follow docs/API.md's shared table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    Status,
    Processes,
    Identities,
    Limits,
    Usage,
    Sessions,
    Auth,
}

const ENDPOINTS: [Endpoint; 7] = [
    Endpoint::Status,
    Endpoint::Processes,
    Endpoint::Identities,
    Endpoint::Limits,
    Endpoint::Usage,
    Endpoint::Sessions,
    Endpoint::Auth,
];

impl Endpoint {
    const fn interval(self) -> Duration {
        match self {
            Self::Status | Self::Processes => Duration::from_secs(3),
            Self::Identities | Self::Auth => Duration::from_secs(10),
            Self::Sessions => Duration::from_secs(15),
            Self::Limits | Self::Usage => Duration::from_secs(60),
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Status => "/api/status",
            Self::Processes => "/api/processes",
            Self::Identities => "/api/identities",
            Self::Limits => "/api/limits",
            Self::Usage => "/api/usage",
            Self::Sessions => "/api/sessions",
            Self::Auth => "/api/auth",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Status => 0,
            Self::Processes => 1,
            Self::Identities => 2,
            Self::Limits => 3,
            Self::Usage => 4,
            Self::Sessions => 5,
            Self::Auth => 6,
        }
    }

    /// Endpoints refreshed by the manual refresh key on the given tab.
    const fn for_tab(tab: usize) -> &'static [Self] {
        match tab {
            0 => &[Self::Status, Self::Processes],
            1 => &[Self::Identities],
            2 => &[Self::Limits],
            3 => &[Self::Usage],
            4 => &[Self::Sessions],
            5 => &[Self::Auth],
            _ => &[],
        }
    }
}

enum Msg {
    Status(Result<models::Status, ApiError>),
    Processes(Result<models::Processes, ApiError>),
    Identities(Result<models::IdentitiesResponse, ApiError>),
    Limits(Result<models::LimitsResponse, ApiError>),
    Usage(Result<models::UsageResponse, ApiError>),
    Sessions(Result<models::SessionsResponse, ApiError>),
    Auth(Result<models::AuthResponse, ApiError>),
}

#[derive(Debug)]
pub struct FetchState<T> {
    pub data: Option<T>,
    pub error: Option<String>,
    pub updated: Option<Instant>,
}

impl<T> Default for FetchState<T> {
    fn default() -> Self {
        Self {
            data: None,
            error: None,
            updated: None,
        }
    }
}

impl<T> FetchState<T> {
    fn record(&mut self, result: Result<T, ApiError>) -> bool {
        match result {
            Ok(data) => {
                self.data = Some(data);
                self.error = None;
                self.updated = Some(Instant::now());
                true
            }
            Err(err) => {
                self.error = Some(err.to_string());
                false
            }
        }
    }
}

pub struct App {
    pub base_url: String,
    pub token_source: String,
    pub tab: usize,
    pub frame: u64,
    pub scrolls: [usize; TAB_COUNT],
    pub status: FetchState<models::Status>,
    pub processes: FetchState<models::Processes>,
    pub identities: FetchState<models::IdentitiesResponse>,
    pub limits: FetchState<models::LimitsResponse>,
    pub usage: FetchState<models::UsageResponse>,
    pub sessions: FetchState<models::SessionsResponse>,
    pub auth: FetchState<models::AuthResponse>,
    /// When the most recent completed fetch failed: the instant its
    /// endpoint polls again (drives the unreachable banner countdown).
    next_retry: Option<Instant>,
    pub quitting: bool,
}

impl App {
    fn new(settings: &Settings) -> Self {
        Self {
            base_url: settings.base_url.clone(),
            token_source: settings.describe_token_source(),
            tab: 0,
            frame: 0,
            scrolls: [0; TAB_COUNT],
            status: FetchState::default(),
            processes: FetchState::default(),
            identities: FetchState::default(),
            limits: FetchState::default(),
            usage: FetchState::default(),
            sessions: FetchState::default(),
            auth: FetchState::default(),
            next_retry: None,
            quitting: false,
        }
    }

    pub fn console_down(&self) -> bool {
        self.next_retry.is_some()
    }

    /// Whole seconds until the next retry against a console that just
    /// failed, minimum 1 so the banner never shows "(retrying in 0s)".
    pub fn retry_in_secs(&self) -> u64 {
        self.next_retry
            .and_then(|at| at.checked_duration_since(Instant::now()))
            .map(|d| d.as_secs_f64().ceil() as u64)
            .unwrap_or(0)
            .max(1)
    }

    fn finish(&mut self, endpoint: Endpoint, ok: bool) {
        if ok {
            self.next_retry = None;
        } else {
            self.next_retry = Some(Instant::now() + endpoint.interval());
        }
    }

    fn apply(&mut self, msg: Msg) {
        macro_rules! record {
            ($field:ident, $endpoint:expr, $result:expr) => {{
                let ok = self.$field.record($result);
                self.finish($endpoint, ok);
            }};
        }
        match msg {
            Msg::Status(result) => record!(status, Endpoint::Status, result),
            Msg::Processes(result) => record!(processes, Endpoint::Processes, result),
            Msg::Identities(result) => record!(identities, Endpoint::Identities, result),
            Msg::Limits(result) => record!(limits, Endpoint::Limits, result),
            Msg::Usage(result) => record!(usage, Endpoint::Usage, result),
            Msg::Sessions(result) => record!(sessions, Endpoint::Sessions, result),
            Msg::Auth(result) => record!(auth, Endpoint::Auth, result),
        }
    }

    fn next_tab(&mut self) {
        self.tab = (self.tab + 1) % TAB_COUNT;
    }

    fn prev_tab(&mut self) {
        self.tab = (self.tab + TAB_COUNT - 1) % TAB_COUNT;
    }

    fn scroll_up(&mut self, amount: usize) {
        let current = &mut self.scrolls[self.tab];
        *current = current.saturating_sub(amount);
    }

    fn scroll_down(&mut self, amount: usize) {
        self.scrolls[self.tab] = self.scrolls[self.tab].saturating_add(amount);
    }
}

async fn fetch_loop(
    client: Arc<ConsoleClient>,
    endpoint: Endpoint,
    tx: mpsc::UnboundedSender<Msg>,
    notify: Arc<Notify>,
) {
    // tokio intervals fire immediately on the first tick, which doubles as
    // the initial load for every endpoint.
    let mut ticker = tokio::time::interval(endpoint.interval());
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = notify.notified() => {}
        }
        let msg = match endpoint {
            Endpoint::Status => Msg::Status(client.get_json(endpoint.path()).await),
            Endpoint::Processes => Msg::Processes(client.get_json(endpoint.path()).await),
            Endpoint::Identities => Msg::Identities(client.get_json(endpoint.path()).await),
            Endpoint::Limits => Msg::Limits(client.get_json(endpoint.path()).await),
            Endpoint::Usage => Msg::Usage(client.get_json(endpoint.path()).await),
            Endpoint::Sessions => Msg::Sessions(client.get_json(endpoint.path()).await),
            Endpoint::Auth => Msg::Auth(client.get_json(endpoint.path()).await),
        };
        if tx.send(msg).is_err() {
            return; // main loop gone: nothing left to feed
        }
    }
}

fn handle_event(app: &mut App, event: Event, notifies: &[Arc<Notify>]) {
    // Resize needs no explicit handling: every render reads f.area() fresh.
    if let Event::Key(key) = event
        && key.kind == KeyEventKind::Press
    {
        handle_key(app, key, notifies);
    }
}
fn handle_key(app: &mut App, key: KeyEvent, notifies: &[Arc<Notify>]) {
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => app.quitting = true,
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quitting = true,
        KeyCode::Char('r') => notify_endpoints(notifies, Endpoint::for_tab(app.tab)),
        KeyCode::Tab if key.modifiers.contains(KeyModifiers::SHIFT) => app.prev_tab(),
        KeyCode::BackTab => app.prev_tab(),
        KeyCode::Tab => app.next_tab(),
        KeyCode::Char(digit @ '1'..='7') => {
            app.tab = digit.to_digit(10).unwrap_or(1) as usize - 1;
        }
        KeyCode::Down | KeyCode::Char('j') => app.scroll_down(1),
        KeyCode::Up | KeyCode::Char('k') => app.scroll_up(1),
        KeyCode::PageDown => app.scroll_down(10),
        KeyCode::PageUp => app.scroll_up(10),
        KeyCode::Home => app.scrolls[app.tab] = 0,
        _ => {}
    }
}

fn notify_endpoints(notifies: &[Arc<Notify>], endpoints: &[Endpoint]) {
    for endpoint in endpoints {
        notifies[endpoint.index()].notify_one();
    }
}

pub async fn run(mut terminal: DefaultTerminal, settings: Settings) -> Result<()> {
    let client =
        Arc::new(ConsoleClient::new(settings.clone()).context("failed to build HTTP client")?);

    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<Msg>();
    let notifies: Vec<Arc<Notify>> = ENDPOINTS.iter().map(|_| Arc::new(Notify::new())).collect();
    for (index, endpoint) in ENDPOINTS.into_iter().enumerate() {
        tokio::spawn(fetch_loop(
            Arc::clone(&client),
            endpoint,
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

    let mut app = App::new(&settings);
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    loop {
        tokio::select! {
            maybe = msg_rx.recv() => match maybe {
                Some(msg) => app.apply(msg),
                None => break,
            },
            maybe = event_rx.recv() => match maybe {
                Some(event) => handle_event(&mut app, event, &notifies),
                None => break,
            },
            _ = ticker.tick() => app.frame = app.frame.wrapping_add(1),
        }
        if app.quitting {
            break;
        }
        terminal
            .draw(|frame| ui::draw(frame, &mut app))
            .context("failed to draw frame")?;
    }
    Ok(())
}
