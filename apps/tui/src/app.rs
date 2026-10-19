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

/// Usage and breakdown request ceiling: the default 10 minute tokscale
/// timeout (AIS_TOKSCALE_TIMEOUT_MS) plus a minute of margin. Warm requests
/// return at once (the console serves stale data while it refreshes); only a
/// cold first scan can approach this.
pub const USAGE_SCAN_CEILING_SECS: u64 = 11 * 60;

pub const TAB_COUNT: usize = 9;
pub const TAB_LOCAL_MODELS: usize = 2;
pub const TAB_BREAKDOWN: usize = 7;
pub const TAB_NAMES: [&str; TAB_COUNT] = [
    "Status",
    "Identities",
    "Local Models",
    "Limits",
    "Usage",
    "Sessions",
    "Auth",
    "Breakdown",
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
    Breakdown,
    LocalModels,
}

const ENDPOINTS: [Endpoint; 9] = [
    Endpoint::Status,
    Endpoint::Processes,
    Endpoint::Identities,
    Endpoint::Limits,
    Endpoint::Usage,
    Endpoint::Sessions,
    Endpoint::Auth,
    Endpoint::Breakdown,
    Endpoint::LocalModels,
];

const PENDING_REPOLL: Duration = Duration::from_secs(3);

impl Endpoint {
    const fn interval(self) -> Duration {
        match self {
            Self::Status | Self::Processes => Duration::from_secs(3),
            Self::Identities | Self::Auth | Self::LocalModels => Duration::from_secs(10),
            Self::Sessions => Duration::from_secs(15),
            Self::Limits | Self::Usage => Duration::from_secs(60),
            // The breakdown scan streams raw session JSONL: the heaviest
            // endpoint, so it polls the least often.
            Self::Breakdown => Duration::from_secs(300),
        }
    }

    /// Whole-request ceiling per endpoint. The scan endpoints must outlast
    /// the console's server-side scan budgets (45s limits; usage and
    /// breakdown up to the 10 minute tokscale ceiling plus margin) so a
    /// cold-cache poll is waited out instead of aborted; see api.rs.
    const fn timeout(self) -> Duration {
        match self {
            Self::Limits => Duration::from_secs(50),
            Self::Usage => Duration::from_secs(USAGE_SCAN_CEILING_SECS),
            Self::Breakdown => Duration::from_secs(USAGE_SCAN_CEILING_SECS),
            _ => Duration::from_secs(20),
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
            Self::Breakdown => "/api/usage/breakdown?days=30",
            Self::LocalModels => "/api/local-models",
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
            Self::Breakdown => 7,
            Self::LocalModels => 8,
        }
    }

    /// Endpoints refreshed by the manual refresh key on the given tab.
    /// Tab 0's identity panel reads limits + usage, so `r` there refreshes
    /// all four sources it renders.
    const fn for_tab(tab: usize) -> &'static [Self] {
        match tab {
            0 => &[Self::Status, Self::Processes, Self::Limits, Self::Usage],
            1 => &[Self::Identities],
            2 => &[Self::LocalModels],
            3 => &[Self::Limits],
            4 => &[Self::Usage],
            5 => &[Self::Sessions],
            6 => &[Self::Auth],
            7 => &[Self::Breakdown],
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
    Breakdown(Result<models::BreakdownResponse, ApiError>),
    LocalModels(Result<models::LocalModelsResponse, ApiError>),
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
    /// Records one poll outcome; pub because the overview mode (a separate
    /// screen with its own endpoints, see overview.rs) shares this type.
    pub fn record(&mut self, result: Result<T, ApiError>) -> bool {
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
    pub breakdown: FetchState<models::BreakdownResponse>,
    pub local_models: FetchState<models::LocalModelsResponse>,
    /// Model name the run loop must hand the terminal to (`ais local start`).
    pub pending_start: Option<String>,
    /// Which breakdown result (one per tool/identity pair) the Breakdown tab
    /// is showing; cycled with `,` / `.` and clamped at render time.
    pub breakdown_selection: usize,
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
            breakdown: FetchState::default(),
            local_models: FetchState::default(),
            pending_start: None,
            breakdown_selection: 0,
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
            Msg::Breakdown(result) => record!(breakdown, Endpoint::Breakdown, result),
            Msg::LocalModels(result) => {
                record!(local_models, Endpoint::LocalModels, result)
            }
        }
    }

    /// Tab index `step` tabs away from `current`, wrapping in both
    /// directions across the TAB_COUNT tabs.
    fn cycle_tab(current: usize, step: i32) -> usize {
        (current as i64 + step as i64).rem_euclid(TAB_COUNT as i64) as usize
    }

    fn next_tab(&mut self) {
        self.tab = Self::cycle_tab(self.tab, 1);
    }

    fn prev_tab(&mut self) {
        self.tab = Self::cycle_tab(self.tab, -1);
    }

    /// Enter on Local Models: start the first model, only with a runner.
    fn request_start(&mut self) {
        self.pending_start = self
            .local_models
            .data
            .as_ref()
            .filter(|data| data.runner.is_some())
            .and_then(|data| data.models.first())
            .map(|model| model.name.clone());
    }

    fn scroll_up(&mut self, amount: usize) {
        let current = &mut self.scrolls[self.tab];
        *current = current.saturating_sub(amount);
    }

    fn scroll_down(&mut self, amount: usize) {
        self.scrolls[self.tab] = self.scrolls[self.tab].saturating_add(amount);
    }

    /// `,` / `.` step through the breakdown results (one per tool/identity
    /// pair); the selection is clamped against the result count at render.
    fn breakdown_select_prev(&mut self) {
        self.breakdown_selection = self.breakdown_selection.saturating_sub(1);
    }

    fn breakdown_select_next(&mut self) {
        self.breakdown_selection = self.breakdown_selection.saturating_add(1);
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
    let mut repoll = false;
    loop {
        if repoll {
            // Server answered "pending" (first scan running): poll again soon.
            tokio::select! {
                _ = tokio::time::sleep(PENDING_REPOLL) => {}
                _ = notify.notified() => {}
            }
            ticker.reset();
        } else {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = notify.notified() => {}
            }
        }
        let msg = match endpoint {
            Endpoint::Status => {
                Msg::Status(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Processes => {
                Msg::Processes(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Identities => {
                Msg::Identities(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Limits => {
                Msg::Limits(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Usage => {
                Msg::Usage(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Sessions => {
                Msg::Sessions(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::Auth => Msg::Auth(client.get_json(endpoint.path(), endpoint.timeout()).await),
            Endpoint::Breakdown => {
                Msg::Breakdown(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
            Endpoint::LocalModels => {
                Msg::LocalModels(client.get_json(endpoint.path(), endpoint.timeout()).await)
            }
        };
        repoll = matches!(&msg, Msg::Usage(Ok(r)) if r.pending)
            || matches!(&msg, Msg::Breakdown(Ok(r)) if r.pending);
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
        // Pages are read-only, so no in-page widget claims Left/Right; the
        // top level owns them for tab cycling while Up/Down keep scrolling.
        KeyCode::Right => app.next_tab(),
        KeyCode::Left => app.prev_tab(),
        KeyCode::Char(digit @ '1'..='9') => {
            app.tab = digit.to_digit(10).unwrap_or(1) as usize - 1;
        }
        // Breakdown identity cycling (breakdown tab only, so typing these
        // elsewhere stays inert).
        KeyCode::Char(',') if app.tab == TAB_BREAKDOWN => app.breakdown_select_prev(),
        KeyCode::Char('.') if app.tab == TAB_BREAKDOWN => app.breakdown_select_next(),
        KeyCode::Enter if app.tab == TAB_LOCAL_MODELS => app.request_start(),
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

const READER_POLL: Duration = Duration::from_millis(100);

/// Pause handshake between the main loop and the blocking reader thread:
/// `pause` returns only once the reader has parked, so nothing reads the
/// terminal while a child owns it.
#[derive(Default)]
struct ReaderGate {
    state: std::sync::Mutex<(bool, bool, bool)>, // (pause requested, parked, reader exited)
    cv: std::sync::Condvar,
}

impl ReaderGate {
    /// Reader side: park while a pause is requested, acknowledging it.
    fn checkpoint(&self) {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while st.0 {
            st.1 = true;
            self.cv.notify_all();
            st = self.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        st.1 = false;
    }

    /// Main side: blocks until the reader has acknowledged the pause.
    fn pause(&self) {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        st.0 = true;
        while !st.1 && !st.2 {
            st = self.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Reader side: the reader is gone, so `pause` must never wait for it.
    fn exited(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).2 = true;
        self.cv.notify_all();
    }

    fn resume(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).0 = false;
        self.cv.notify_all();
    }
}

/// Runs `ais local start <name>` with inherited stdio and waits for it.
/// Blocking is intended: the child owns the terminal. Returns an error
/// message when it could not start or exited non-zero.
fn run_local_start(name: &str) -> Option<String> {
    match std::process::Command::new("ais")
        .args(["local", "start", name])
        .status()
    {
        Ok(status) if status.success() => None,
        // Stopped by a signal (e.g. Ctrl+C): the user chose that, no prompt.
        Ok(status) if status.code().is_none() => None,
        Ok(status) => Some(format!("ais local start exited with {status}")),
        Err(err) => Some(format!("could not run ais: {err}")),
    }
}

/// Drops keystrokes typed during the hand-off so they are not replayed.
fn drain_input(event_rx: &mut mpsc::UnboundedReceiver<Event>) {
    while event_rx.try_recv().is_ok() {}
    while crossterm::event::poll(Duration::ZERO).unwrap_or(false) {
        if crossterm::event::read().is_err() {
            break;
        }
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
    // It polls so it can pause while a child owns the terminal (`ais local
    // start`) instead of stealing the child's keystrokes.
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Event>();
    let gate = Arc::new(ReaderGate::default());
    let reader_gate = Arc::clone(&gate);
    std::thread::spawn(move || {
        loop {
            reader_gate.checkpoint();
            match crossterm::event::poll(READER_POLL) {
                Ok(true) => match crossterm::event::read() {
                    Ok(event) => {
                        if event_tx.send(event).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {}
                Err(_) => break,
            }
        }
        reader_gate.exited();
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
        if let Some(name) = app.pending_start.take() {
            // Catch SIGINT here so Ctrl+C (cooked mode, same process group)
            // reaches only the child; its handler resets to default on exec.
            let sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .context("failed to install SIGINT handler")?;
            let pause_gate = Arc::clone(&gate);
            tokio::task::spawn_blocking(move || pause_gate.pause())
                .await
                .context("reader pause failed")?;
            ratatui::restore();
            let failure = run_local_start(&name);
            if let Some(message) = failure {
                eprintln!("{message}");
                eprintln!("Press Enter to return to the dashboard.");
                let mut line = String::new();
                let _ = std::io::stdin().read_line(&mut line);
            }
            drop(sigint);
            terminal = ratatui::init();
            // Drain while the reader is still parked, or it could take the
            // input first and the stale keys would replay.
            drain_input(&mut event_rx);
            gate.resume();
            terminal.clear().context("failed to repaint")?;
        }
        terminal
            .draw(|frame| ui::draw(frame, &mut app))
            .context("failed to draw frame")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_app() -> App {
        let settings = Settings {
            base_url: String::new(),
            token: None,
            token_path: PathBuf::from("/synthetic/SYNTHETIC_FIXTURE/server.json"),
        };
        App::new(&settings)
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn press(app: &mut App, code: KeyCode) {
        handle_key(app, key(code), &[]);
    }

    #[test]
    fn cycle_tab_wraps_forward_and_backward() {
        assert_eq!(App::cycle_tab(0, 1), 1);
        assert_eq!(App::cycle_tab(TAB_COUNT - 1, 1), 0);
        assert_eq!(App::cycle_tab(0, -1), TAB_COUNT - 1);
        assert_eq!(App::cycle_tab(3, TAB_COUNT as i32), 3);
        assert_eq!(App::cycle_tab(3, -(TAB_COUNT as i32)), 3);
    }

    #[test]
    fn right_and_left_arrows_cycle_tabs_with_wraparound() {
        let mut app = test_app();
        assert_eq!(app.tab, 0);
        press(&mut app, KeyCode::Left);
        assert_eq!(app.tab, TAB_COUNT - 1, "Left from the first tab wraps");
        press(&mut app, KeyCode::Right);
        assert_eq!(app.tab, 0, "Right from the last tab wraps home");
        press(&mut app, KeyCode::Right);
        assert_eq!(app.tab, 1);
    }

    #[test]
    fn tab_and_backtab_still_cycle() {
        let mut app = test_app();
        app.tab = TAB_COUNT - 1;
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.tab, 0);
        press(&mut app, KeyCode::BackTab);
        assert_eq!(app.tab, TAB_COUNT - 1);
    }

    #[test]
    fn number_keys_still_jump_to_tabs() {
        let mut app = test_app();
        for (digit, expected) in [('1', 0), ('4', 3), ('7', 6), ('9', TAB_COUNT - 1)] {
            press(&mut app, KeyCode::Char(digit));
            assert_eq!(app.tab, expected, "digit {digit} jumps to tab");
        }
    }

    #[test]
    fn reader_gate_pause_waits_for_park_acknowledgement() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let gate = Arc::new(ReaderGate::default());
        let ticks = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (g, t, st) = (Arc::clone(&gate), Arc::clone(&ticks), Arc::clone(&stop));
        let reader = std::thread::spawn(move || {
            while !st.load(Ordering::SeqCst) {
                g.checkpoint();
                t.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        gate.pause(); // returns only after the reader acknowledged
        let frozen = ticks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(ticks.load(Ordering::SeqCst), frozen, "reader is parked");
        gate.resume();
        std::thread::sleep(Duration::from_millis(30));
        assert!(ticks.load(Ordering::SeqCst) > frozen, "reader resumed");
        stop.store(true, Ordering::SeqCst);
        reader.join().unwrap();
    }

    #[test]
    fn reader_gate_pause_returns_after_reader_exit() {
        let gate = Arc::new(ReaderGate::default());
        let g = Arc::clone(&gate);
        std::thread::spawn(move || g.exited()).join().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            gate.pause();
            let _ = tx.send(());
        });
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "pause hung"
        );
    }

    #[test]
    fn tab_names_put_local_models_beside_identities() {
        assert_eq!(TAB_NAMES[1], "Identities");
        assert_eq!(TAB_NAMES[2], "Local Models");
    }

    #[test]
    fn number_keys_jump_including_local_models() {
        let mut app = test_app();
        press(&mut app, KeyCode::Char('3'));
        assert_eq!(app.tab, 2);
        press(&mut app, KeyCode::Char('9'));
        assert_eq!(app.tab, TAB_COUNT - 1);
    }

    #[test]
    fn comma_dot_still_cycle_breakdown_on_its_new_index() {
        let mut app = test_app();
        app.tab = TAB_BREAKDOWN;
        press(&mut app, KeyCode::Char('.'));
        assert_eq!(app.breakdown_selection, 1);
        press(&mut app, KeyCode::Char(','));
        assert_eq!(app.breakdown_selection, 0);
    }

    fn with_models(app: &mut App, runner: Option<&str>, names: &[&str]) {
        app.local_models.data = Some(models::LocalModelsResponse {
            online: true,
            runner: runner.map(str::to_string),
            models: names
                .iter()
                .map(|name| models::LocalModelEntry {
                    name: (*name).to_string(),
                    path: format!("/synthetic/{name}.gguf"),
                    size_bytes: 1024,
                })
                .collect(),
        });
    }

    #[test]
    fn enter_on_local_models_requests_start_of_first_model() {
        let mut app = test_app();
        app.tab = TAB_LOCAL_MODELS;
        with_models(&mut app, Some("llama-cli"), &["tiny", "other"]);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.pending_start.as_deref(), Some("tiny"));
    }

    #[test]
    fn enter_without_runner_or_model_requests_nothing() {
        let mut app = test_app();
        app.tab = TAB_LOCAL_MODELS;
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.pending_start, None, "nothing fetched");
        with_models(&mut app, None, &["tiny"]);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.pending_start, None, "no runner");
        with_models(&mut app, Some("llama-cli"), &[]);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.pending_start, None, "no model");
    }

    #[test]
    fn enter_on_other_tabs_requests_nothing() {
        let mut app = test_app();
        app.tab = 1;
        with_models(&mut app, Some("llama-cli"), &["tiny"]);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.pending_start, None);
    }

    #[test]
    fn comma_dot_cycle_breakdown_identity_selection() {
        let mut app = test_app();
        app.tab = TAB_BREAKDOWN;
        press(&mut app, KeyCode::Char('.'));
        press(&mut app, KeyCode::Char('.'));
        assert_eq!(app.breakdown_selection, 2);
        press(&mut app, KeyCode::Char(','));
        assert_eq!(app.breakdown_selection, 1);
        // Never underflows.
        press(&mut app, KeyCode::Char(','));
        press(&mut app, KeyCode::Char(','));
        assert_eq!(app.breakdown_selection, 0);
        // Inert outside the breakdown tab.
        app.tab = 3;
        press(&mut app, KeyCode::Char('.'));
        assert_eq!(app.breakdown_selection, 0);
        assert_eq!(app.tab, 3);
    }

    #[test]
    fn vertical_keys_keep_scrolling_without_changing_tab() {
        let mut app = test_app();
        app.tab = 5;
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.scrolls[5], 2);
        press(&mut app, KeyCode::Up);
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.scrolls[5], 0);
        assert_eq!(app.tab, 5, "Up/Down never switch tabs");
        assert_eq!(app.scrolls[0], 0, "only the active tab scrolls");
    }

    #[test]
    fn quit_keys_are_unchanged() {
        for code in [KeyCode::Char('q'), KeyCode::Esc] {
            let mut app = test_app();
            press(&mut app, code);
            assert!(app.quitting, "{code:?} still quits");
        }
    }
}
