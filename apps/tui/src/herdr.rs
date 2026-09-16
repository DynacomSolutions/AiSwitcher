//! `aistui herdr`: the native `ais herdr` wrapper, and the tmux
//! replacement. The LEFT region is an embedded terminal (see embed.rs)
//! hosting the REAL herdr client as a child PTY; the RIGHT region is the
//! overview panel rendered natively by this binary (overview.rs lifted into
//! a reusable rect); a one-line status bar runs along the bottom.
//!
//! Input model (deliberate, and shown on screen in the status bar):
//! - the herdr region owns focus by default: every key, mouse report and
//!   paste goes to herdr verbatim, `q` included (it belongs to herdr),
//! - `Tab` toggles focus to the overview panel, whose keys are j/k (and
//!   arrows, PgUp/PgDn) to scroll, `r` to refresh, `q` to quit the wrapper,
//! - the wrapper reserves exactly two byte sequences globally: a lone `Tab`
//!   and `Ctrl+C` (first press forwards to herdr, a second press within one
//!   second force-quits the wrapper),
//! - when the herdr child exits, the region keeps its last frame, focus
//!   moves to the panel, and `r` restarts / `q` quits.
//!
//! Input is read as RAW BYTES, never crossterm events, so forwarding to
//! herdr is lossless (every exotic binding, mouse report and paste passes
//! through exactly as typed). The cost is that the panel's own keys are a
//! fixed byte-level subset, which is all it needs.
//!
//! Killing semantics: the child is the herdr CLIENT; quitting kills only
//! the client. Detaching is safe by design - herdr sessions live
//! server-side - so nothing else is ever signalled.

use std::io::{Read as _, Write as _};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use ratatui::DefaultTerminal;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::mpsc;

use crate::api::ConsoleClient;
use crate::config::Settings;
use crate::embed::{EmbeddedTerm, ExitInfo, MirroredModes, PtyEvent, SpawnSpec, mirrored_modes};
use crate::overview::{OverviewApp, OverviewEnv, OverviewPoller, spawn_poller};
use crate::ui::widgets;

pub const DEFAULT_PANEL_WIDTH: u16 = 42;
pub const MIN_PANEL_WIDTH: u16 = 16;
pub const MAX_PANEL_WIDTH: u16 = 80;

/// Narrowest herdr region the layout tolerates before the panel gives up
/// width (and, below a usable floor, disappears entirely).
const MIN_HERDR_WIDTH: u16 = 24;
const MIN_PANEL_FLOOR: u16 = 8;

/// Ctrl+C pressed twice within this window force-quits the wrapper.
const FORCE_QUIT_WINDOW: Duration = Duration::from_secs(1);

/* --------------------------------- arguments -------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrArgs {
    /// `--remote <target>`: the child runs `herdr --remote <target>`.
    pub remote: Option<String>,
    pub panel_width: u16,
    /// Full path of the herdr binary, resolved (and overridden via
    /// AIS_HERDR_BIN) by the TS wrapper; the Rust side never re-resolves.
    pub herdr_bin: String,
}

impl Default for HerdrArgs {
    fn default() -> Self {
        Self {
            remote: None,
            panel_width: DEFAULT_PANEL_WIDTH,
            herdr_bin: "herdr".to_string(),
        }
    }
}

/// Flags that consume a following value (also accepted as --flag=value).
const VALUE_FLAGS: [&str; 3] = ["--remote", "--panel-width", "--herdr-bin"];

pub fn parse_args(argv: &[String]) -> Result<HerdrArgs> {
    // Fold the space form first so matching below only sees name/value
    // pairs; --flag=value arrives pre-joined.
    let mut pairs: Vec<(&str, Option<&str>)> = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        let raw = argv[index].as_str();
        if let Some((name, inline)) = raw.split_once('=') {
            if !raw.starts_with("--") {
                bail!("unexpected argument \"{raw}\"");
            }
            pairs.push((name, Some(inline)));
        } else if raw.starts_with("--") {
            if VALUE_FLAGS.contains(&raw) {
                let value = argv
                    .get(index + 1)
                    .ok_or_else(|| anyhow::anyhow!("{raw} requires a value"))?;
                index += 1;
                pairs.push((raw, Some(value)));
            } else {
                pairs.push((raw, None));
            }
        } else {
            bail!("unexpected argument \"{raw}\"");
        }
        index += 1;
    }

    let mut args = HerdrArgs::default();
    for (name, value) in pairs {
        match (name, value) {
            ("--remote", Some(v)) => args.remote = Some(v.to_string()),
            ("--remote", None) => bail!("--remote requires a value"),
            ("--herdr-bin", Some(v)) => args.herdr_bin = v.to_string(),
            ("--herdr-bin", None) => bail!("--herdr-bin requires a value"),
            ("--panel-width", Some(v)) => {
                let parsed: u16 = v.parse().map_err(|_| width_error(v))?;
                if !(MIN_PANEL_WIDTH..=MAX_PANEL_WIDTH).contains(&parsed) {
                    return Err(width_error(v));
                }
                args.panel_width = parsed;
            }
            ("--panel-width", None) => bail!("--panel-width requires a value"),
            (other, _) => bail!("unknown aistui herdr flag \"{other}\""),
        }
    }
    Ok(args)
}

fn width_error(got: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "--panel-width must be an integer between {MIN_PANEL_WIDTH} and {MAX_PANEL_WIDTH} (got \"{got}\")"
    )
}

impl HerdrArgs {
    /// The child command line: plain `herdr`, or the remote passthrough
    /// form (`herdr --remote <target>`), both verified against herdr's own
    /// usage.
    pub fn child_spec(&self) -> SpawnSpec {
        let args = match &self.remote {
            Some(target) => vec!["--remote".to_string(), target.clone()],
            None => vec![],
        };
        SpawnSpec::new(self.herdr_bin.clone(), args)
    }
}

/* ---------------------------------- layout ---------------------------------- */

/// The wrapper's three regions, computed from the outer size plus the
/// requested panel width. The panel yields: below `MIN_HERDR_WIDTH` of
/// leftover herdr space it shrinks, and below a usable floor it disappears
/// so herdr keeps the whole width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrapperLayout {
    pub herdr: Rect,
    pub panel: Option<Rect>,
    pub status: Rect,
}

pub fn compute_layout(area: Rect, requested_panel_width: u16) -> WrapperLayout {
    let body = Rect {
        height: area.height.saturating_sub(1),
        ..area
    };
    let status = Rect {
        y: area.y.saturating_add(body.height),
        height: 1,
        ..area
    };
    if body.width == 0 || body.height == 0 {
        return WrapperLayout {
            herdr: body,
            panel: None,
            status,
        };
    }
    let available = body.width.saturating_sub(MIN_HERDR_WIDTH);
    let panel_width = available.min(requested_panel_width);
    let (herdr_width, panel) = if panel_width < MIN_PANEL_FLOOR {
        (body.width, None)
    } else {
        let herdr_width = body.width - panel_width;
        let panel = Rect {
            x: body.x.saturating_add(herdr_width),
            width: panel_width,
            ..body
        };
        (herdr_width, Some(panel))
    };
    WrapperLayout {
        herdr: Rect {
            width: herdr_width,
            ..body
        },
        panel,
        status,
    }
}

/* ------------------------------- input routing ------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Focus {
    #[default]
    Herdr,
    Panel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ChildState {
    Running,
    Exited(ExitInfo),
    Failed(String),
}

/// The wrapper-owned input state; pure and unit-tested through
/// `process_chunk`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapperState {
    focus: Focus,
    child: ChildState,
    force_quit_armed_at: Option<Instant>,
}

impl WrapperState {
    fn new() -> Self {
        Self {
            focus: Focus::Herdr,
            child: ChildState::Running,
            force_quit_armed_at: None,
        }
    }

    /// The panel's keys only count while it has focus and herdr is alive;
    /// a dead child hands every key to the death screen instead.
    fn panel_drives(&self) -> bool {
        self.focus == Focus::Panel && self.child == ChildState::Running
    }

    fn dead(&self) -> bool {
        self.child != ChildState::Running
    }
}

/// What the event loop should do about one chunk of raw stdin bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Nothing wrapper-owned; the chunk is dropped (unknown bytes on panel
    /// focus, keys on a dead pane that are not r/q).
    Ignore,
    /// Forward the chunk to the PTY verbatim.
    Forward,
    /// Drive the embedded overview panel.
    Panel(OverviewInput),
    /// Respawn the herdr child.
    Restart,
    /// Quit the wrapper (killing the child client).
    Quit,
}

/// Keys the overview panel understands while it has focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverviewInput {
    Up,
    Down,
    PageUp,
    PageDown,
    Refresh,
    Quit,
}

/// Whole-chunk matcher for the panel's keys. Chunks are what one read()
/// returned; a real keypress arrives as one chunk, so matching the chunk
/// whole keeps paste and escape-sequence ambiguity out. Mouse scroll
/// reports are understood in both SGR and legacy X10 form - and they can
/// only arrive at all when herdr itself enabled mouse tracking (the
/// wrapper mirrors the child's modes onto the real terminal).
pub fn overview_input(chunk: &[u8]) -> Option<OverviewInput> {
    match chunk {
        b"q" | b"\x1b" => Some(OverviewInput::Quit),
        b"j" | b"\x1b[B" => Some(OverviewInput::Down),
        b"k" | b"\x1b[A" => Some(OverviewInput::Up),
        b"r" => Some(OverviewInput::Refresh),
        b"\x1b[5~" => Some(OverviewInput::PageUp),
        b"\x1b[6~" => Some(OverviewInput::PageDown),
        // SGR mouse: CSI < button ; col ; row (M = press, m = release).
        s if s.starts_with(b"\x1b[<64;") && s.ends_with(b"M") => Some(OverviewInput::Up),
        s if s.starts_with(b"\x1b[<65;") && s.ends_with(b"M") => Some(OverviewInput::Down),
        // Legacy X10: CSI M b x y, wheel is b = 0x60/0x61 on press.
        s if s.len() == 6 && s.starts_with(b"\x1b[M") => match s[3] {
            0x60 => Some(OverviewInput::Up),
            0x61 => Some(OverviewInput::Down),
            _ => None,
        },
        _ => None,
    }
}

/// Death-screen keys: the child is gone, so `r` restarts, `q` (or a lone
/// escape) quits and nothing else means anything.
fn death_input(chunk: &[u8]) -> Option<Action> {
    match chunk {
        b"r" => Some(Action::Restart),
        b"q" | b"\x1b" => Some(Action::Quit),
        _ => None,
    }
}

/// The wrapper's byte-level routing. See the module docs for the model.
/// `now` is injected so the Ctrl+C double-press window is testable.
pub fn process_chunk(state: &mut WrapperState, chunk: &[u8], now: Instant) -> Action {
    // Global reservations first: Ctrl+C and a lone Tab, whatever the focus.
    if chunk == b"\x03" {
        let armed = state
            .force_quit_armed_at
            .is_some_and(|at| now.duration_since(at) <= FORCE_QUIT_WINDOW);
        if armed {
            return Action::Quit;
        }
        state.force_quit_armed_at = Some(now);
        return Action::Forward;
    }
    if chunk == b"\x09" {
        state.focus = match state.focus {
            Focus::Herdr => Focus::Panel,
            Focus::Panel => Focus::Herdr,
        };
        return Action::Ignore;
    }
    state.force_quit_armed_at = None;

    if state.dead() {
        return death_input(chunk).unwrap_or(Action::Ignore);
    }
    if state.panel_drives() {
        return overview_input(chunk)
            .map(Action::Panel)
            .unwrap_or(Action::Ignore);
    }
    Action::Forward
}

/* --------------------------------- status bar ------------------------------- */

/// The bottom bar: focus badge, herdr child state, remote/tunnel label.
/// Pure for tests; `width` is the bar's own cell width for padding.
pub fn status_line(state: &WrapperState, remote: Option<&str>, width: usize) -> Line<'static> {
    let focus_badge = match state.focus {
        Focus::Herdr => {
            Span::from(" herdr ").style(Style::new().fg(Color::Black).bg(Color::Cyan).bold())
        }
        Focus::Panel => {
            Span::from(" panel ").style(Style::new().fg(Color::Black).bg(Color::Yellow).bold())
        }
    };
    let child = match &state.child {
        ChildState::Running => {
            // Focus-aware key hints: q belongs to herdr while herdr has
            // focus, and quits the wrapper only from the panel.
            let hints = match state.focus {
                Focus::Herdr => " herdr running · tab: panel · ctrl+c ctrl+c quits",
                Focus::Panel => " herdr running · tab: herdr · q quit · ctrl+c ×2 quits",
            };
            Span::from(hints).dark_gray()
        }
        ChildState::Exited(info) => {
            let text = format!(" herdr {} · r restart · q quit ", info.describe());
            if info.code == Some(0) {
                Span::from(text).green()
            } else {
                Span::from(text).yellow()
            }
        }
        ChildState::Failed(err) => {
            Span::from(format!(" herdr failed to start: {err} · r retry · q quit ")).red()
        }
    };
    let label = Span::from(remote.unwrap_or("local").to_string()).cyan();
    // A narrow bar cannot hold everything: the child state is the
    // truncatable middle, the focus badge and the remote label are not.
    let used = 7usize.saturating_add(label.content.chars().count());
    let mut child = child;
    if used + child.content.chars().count() > width {
        let budget = width.saturating_sub(used).max(1);
        let truncated = widgets::ellipsize(child.content.as_ref(), budget);
        child = Span::from(truncated).style(child.style);
    }
    widgets::spaced_line(vec![focus_badge, child], vec![label], width)
}

/* --------------------------------- teardown --------------------------------- */

/// Disables every mirrored mode on the real terminal; safe to run when
/// nothing was ever enabled. Runs on normal exit AND on panic (via the
/// panic hook) so the owner's shell never keeps herdr's mouse tracking.
fn teardown_modes() {
    let _ = std::io::stdout()
        .write_all(b"\x1b[?1002l\x1b[?1003l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b[?66l");
    let _ = std::io::stdout().flush();
}

/// Writes the sequences that move the real terminal from `last` to the
/// child's current screen modes, and stores the new state.
fn sync_modes(screen: &vt100::Screen, last: &mut MirroredModes) {
    sync_modes_to(last, mirrored_modes(screen));
}

/// Writes the sequences that move the real terminal from `last` to
/// `target`, and stores the new state.
fn sync_modes_to(last: &mut MirroredModes, target: MirroredModes) {
    let mut stdout = std::io::stdout();
    for sequence in target.sync_sequences(*last) {
        let _ = stdout.write_all(sequence);
    }
    let _ = stdout.flush();
    *last = target;
}

/* --------------------------------- rendering -------------------------------- */

fn draw(
    f: &mut Frame<'_>,
    state: &WrapperState,
    term: Option<&EmbeddedTerm>,
    overview: &mut OverviewApp,
    layout: &WrapperLayout,
    remote: Option<&str>,
) {
    match (term, &state.child) {
        (Some(term), _) => {
            let show_cursor = state.focus == Focus::Herdr && state.child == ChildState::Running;
            term.render(f, layout.herdr, show_cursor);
        }
        (None, ChildState::Failed(err)) => {
            let message = Line::from(vec![
                Span::from(" herdr failed to start: ").red().bold(),
                Span::from(err.clone()).red(),
                Span::from("  (r retry · q quit)").dark_gray(),
            ]);
            f.render_widget(ratatui::widgets::Paragraph::new(message), layout.herdr);
        }
        (None, _) => {}
    }
    if let Some(panel) = layout.panel {
        crate::overview::draw_in(f, overview, panel);
    }
    f.render_widget(
        ratatui::widgets::Paragraph::new(status_line(
            state,
            remote,
            usize::from(layout.status.width),
        )),
        layout.status,
    );
}

/* ---------------------------------- the app --------------------------------- */

pub async fn run(mut terminal: DefaultTerminal, argv: &[String]) -> Result<()> {
    let args = parse_args(argv).context("invalid aistui herdr arguments")?;
    let settings = Settings::load().context("failed to resolve console settings")?;
    let env = OverviewEnv {
        embedded: true,
        ..OverviewEnv::from_env()
    };
    let client =
        Arc::new(ConsoleClient::new(settings.clone()).context("failed to build HTTP client")?);
    let mut poller = spawn_poller(Arc::clone(&client), &env);
    let mut overview = OverviewApp::new(&settings, env);

    // Panic safety: restore the mirrored terminal modes even if a bug
    // unwinds mid-draw, then let ratatui's own hook restore the screen.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        teardown_modes();
        previous_hook(info);
    }));

    let spec = args.child_spec();
    let remote_label = args
        .remote
        .as_ref()
        .map(|target| format!("remote:{target}"));
    let mut state = WrapperState::new();
    let mut last_modes = MirroredModes::DEFAULT;

    let mut layout = compute_layout(Rect::from(terminal.size()?), args.panel_width);
    let (mut term, mut pty_rx) = spawn_child(&spec, &mut state, &layout, &mut last_modes);

    // Raw stdin bytes, read directly (never via crossterm events) so a
    // focused herdr receives input exactly as typed.
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if input_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut winch = signal(SignalKind::window_change()).context("failed to watch for resizes")?;
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    loop {
        tokio::select! {
            chunk = input_rx.recv() => {
                let Some(chunk) = chunk else { break }; // stdin closed
                match process_chunk(&mut state, &chunk, Instant::now()) {
                    Action::Quit => break,
                    Action::Forward => {
                        if let Some(term) = term.as_mut() {
                            term.write_input(&chunk);
                        }
                    }
                    Action::Panel(input) => apply_panel_input(&mut overview, &poller, input),
                    Action::Restart => {
                        // Drop the old term first: killing the client and
                        // closing its master releases the pty.
                        if let Some(mut old) = term.take() {
                            old.kill();
                        }
                        let (fresh, rx) =
                            spawn_child(&spec, &mut state, &layout, &mut last_modes);
                        term = fresh;
                        pty_rx = rx;
                    }
                    Action::Ignore => {}
                }
            }
            event = pty_rx.recv() => {
                match event {
                    Some(PtyEvent::Output(bytes)) => {
                        if let Some(term) = term.as_mut() {
                            term.ingest(&bytes);
                            sync_modes(term.screen(), &mut last_modes);
                        }
                    }
                    Some(PtyEvent::Exited(info)) => {
                        state.child = ChildState::Exited(info);
                        // The child's modes died with it; drop ours back to
                        // neutral and hand focus to the death screen's keys.
                        sync_modes_to(&mut last_modes, MirroredModes::DEFAULT);
                        state.focus = Focus::Panel;
                    }
                    None => {
                        // Reader and waiter both gone: the pty closed under
                        // a still-running child (should not happen; treat
                        // like an exit so the death screen shows).
                        if state.child == ChildState::Running {
                            state.child = ChildState::Exited(ExitInfo {
                                code: None,
                                signal: None,
                            });
                            sync_modes_to(&mut last_modes, MirroredModes::DEFAULT);
                            state.focus = Focus::Panel;
                            pty_rx = closed_pty();
                        }
                    }
                }
            }
            Some(msg) = poller.msgs.recv() => overview.apply(msg),
            _ = winch.recv() => {
                if let Ok((cols, rows)) = crossterm::terminal::size() {
                    let fresh = compute_layout(Rect::new(0, 0, cols, rows), args.panel_width);
                    let herdr_resized = fresh.herdr.width != layout.herdr.width
                        || fresh.herdr.height != layout.herdr.height;
                    if herdr_resized
                        && let Some(term) = term.as_mut()
                    {
                        let _ =
                            term.resize(fresh.herdr.width.max(1), fresh.herdr.height.max(1));
                    }
                    layout = fresh;
                }
            }
            _ = ticker.tick() => overview.frame = overview.frame.wrapping_add(1),
        }
        if overview.quitting {
            break;
        }
        terminal
            .draw(|f| {
                draw(
                    f,
                    &state,
                    term.as_ref(),
                    &mut overview,
                    &layout,
                    remote_label.as_deref(),
                )
            })
            .context("failed to draw the herdr wrapper frame")?;
    }

    if let Some(term) = term.as_mut() {
        term.kill();
    }
    drop(term); // closes the pty master, ending the reader thread
    teardown_modes();
    Ok(())
}

/// Spawns the child, or records the failure on the state and hands back a
/// closed event channel so the loop stays uniform either way.
fn spawn_child(
    spec: &SpawnSpec,
    state: &mut WrapperState,
    layout: &WrapperLayout,
    last_modes: &mut MirroredModes,
) -> (Option<EmbeddedTerm>, mpsc::UnboundedReceiver<PtyEvent>) {
    match EmbeddedTerm::spawn(
        spec.clone(),
        layout.herdr.width.max(1),
        layout.herdr.height.max(1),
    ) {
        Ok((term, rx)) => {
            state.child = ChildState::Running;
            state.focus = Focus::Herdr;
            state.force_quit_armed_at = None;
            *last_modes = MirroredModes::DEFAULT;
            (Some(term), rx)
        }
        Err(err) => {
            state.child = ChildState::Failed(format!("{err:#}"));
            state.focus = Focus::Panel;
            (None, closed_pty())
        }
    }
}

/// Panel keys while the panel has focus. The death screen's `r` never gets
/// here (process_chunk turns it into Action::Restart first).
fn apply_panel_input(overview: &mut OverviewApp, poller: &OverviewPoller, input: OverviewInput) {
    match input {
        OverviewInput::Up => overview.scroll = overview.scroll.saturating_sub(1),
        OverviewInput::Down => overview.scroll = overview.scroll.saturating_add(1),
        OverviewInput::PageUp => overview.scroll = overview.scroll.saturating_sub(10),
        OverviewInput::PageDown => overview.scroll = overview.scroll.saturating_add(10),
        OverviewInput::Refresh => poller.refresh_all(),
        OverviewInput::Quit => overview.quitting = true,
    }
}

/// A closed channel: recv() returns None immediately. Used when no child
/// could be spawned (or the pty closed unexpectedly) so the loop always has
/// a receiver to select on.
fn closed_pty() -> mpsc::UnboundedReceiver<PtyEvent> {
    let (tx, rx) = mpsc::unbounded_channel();
    drop(tx);
    rx
}

/* ---------------------------------- tests ----------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> WrapperState {
        WrapperState::new()
    }

    /// A synthetic clock base; tests offset from it.
    fn at(millis: u64) -> Instant {
        Instant::now() + Duration::from_millis(millis)
    }

    fn running(chunk: &[u8]) -> Action {
        let mut s = state();
        process_chunk(&mut s, chunk, at(0))
    }

    #[test]
    fn args_parse_the_documented_surface() {
        let argv: Vec<String> = ["--remote", "herdr.example", "--panel-width", "38"]
            .iter()
            .map(|f| f.to_string())
            .collect();
        let args = parse_args(&argv).unwrap();
        assert_eq!(args.remote.as_deref(), Some("herdr.example"));
        assert_eq!(args.panel_width, 38);
        assert_eq!(args.herdr_bin, "herdr");
        // Defaults.
        assert_eq!(parse_args(&[]).unwrap(), HerdrArgs::default());
    }

    #[test]
    fn args_accept_the_equals_form_and_herdr_bin() {
        let argv: Vec<String> = [
            "--remote=box",
            "--panel-width=60",
            "--herdr-bin=/opt/bin/herdr",
        ]
        .iter()
        .map(|f| f.to_string())
        .collect();
        let args = parse_args(&argv).unwrap();
        assert_eq!(args.remote.as_deref(), Some("box"));
        assert_eq!(args.panel_width, 60);
        assert_eq!(args.herdr_bin, "/opt/bin/herdr");
    }

    #[test]
    fn args_reject_garbage_and_bounds() {
        let bad: Vec<Vec<String>> = [
            vec!["junk"],
            vec!["--remote"],
            vec!["--panel-width"],
            vec!["--panel-width", "42x"],
            vec!["--panel-width", "15"],
            vec!["--panel-width", "81"],
            vec!["--wat"],
        ]
        .iter()
        .map(|flags| flags.iter().map(|f| f.to_string()).collect())
        .collect();
        for argv in bad {
            assert!(parse_args(&argv).is_err(), "expected {argv:?} to fail");
        }
    }

    #[test]
    fn child_spec_carries_the_remote_passthrough() {
        let args = HerdrArgs::default();
        assert_eq!(args.child_spec(), SpawnSpec::new("herdr", vec![]));
        let remote = HerdrArgs {
            remote: Some("box".to_string()),
            ..HerdrArgs::default()
        };
        assert_eq!(
            remote.child_spec(),
            SpawnSpec::new("herdr", vec!["--remote".to_string(), "box".to_string()]),
        );
    }

    /* -------------------------------- layout -------------------------------- */

    fn area(width: u16, height: u16) -> Rect {
        Rect::new(0, 0, width, height)
    }

    #[test]
    fn layout_splits_herdr_panel_and_status_bar() {
        let layout = compute_layout(area(120, 40), 42);
        assert_eq!(layout.herdr.width, 78);
        assert_eq!(layout.herdr.height, 39);
        let panel = layout.panel.unwrap();
        assert_eq!(panel.width, 42);
        assert_eq!(panel.x, 78);
        assert_eq!(panel.height, 39);
        assert_eq!(layout.status.height, 1);
        assert_eq!(layout.status.y, 39);
    }

    #[test]
    fn panel_yields_width_before_it_disappears() {
        // Plenty of room: the panel gets exactly what it asked for.
        let layout = compute_layout(area(100, 30), 42);
        assert_eq!(layout.herdr.width, 58);
        assert_eq!(layout.panel.unwrap().width, 42);
        // 50 columns: herdr keeps its 24-column floor and the panel yields
        // the rest.
        let layout = compute_layout(area(50, 30), 42);
        assert_eq!(layout.herdr.width, 24);
        assert_eq!(layout.panel.unwrap().width, 26);
        // 30 columns: the floor wins and the panel disappears entirely.
        let layout = compute_layout(area(30, 20), 42);
        assert_eq!(layout.herdr.width, 30);
        assert!(layout.panel.is_none());
    }

    #[test]
    fn tiny_terminals_degrade_to_herdr_only() {
        let layout = compute_layout(area(20, 5), 42);
        assert_eq!(layout.herdr.width, 20);
        assert!(layout.panel.is_none());
        assert_eq!(layout.status.height, 1);
    }

    /* ----------------------------- input routing ---------------------------- */

    #[test]
    fn herdr_focus_forwards_everything_verbatim() {
        for chunk in [&b"q"[..], b"j", b"\x1b[A", b"hello world", b"\x1b[<0;12;5M"] {
            assert_eq!(running(chunk), Action::Forward, "chunk {chunk:?}");
        }
    }

    #[test]
    fn tab_toggles_focus_both_ways() {
        let mut s = state();
        assert_eq!(process_chunk(&mut s, b"\x09", at(0)), Action::Ignore);
        assert_eq!(s.focus, Focus::Panel);
        assert_eq!(process_chunk(&mut s, b"\x09", at(0)), Action::Ignore);
        assert_eq!(s.focus, Focus::Herdr);
    }

    #[test]
    fn panel_focus_drives_the_overview_and_drops_the_rest() {
        let mut s = state();
        assert_eq!(process_chunk(&mut s, b"\x09", at(0)), Action::Ignore);
        assert_eq!(
            process_chunk(&mut s, b"j", at(0)),
            Action::Panel(OverviewInput::Down)
        );
        assert_eq!(
            process_chunk(&mut s, b"k", at(0)),
            Action::Panel(OverviewInput::Up)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[5~", at(0)),
            Action::Panel(OverviewInput::PageUp)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[6~", at(0)),
            Action::Panel(OverviewInput::PageDown)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[B", at(0)),
            Action::Panel(OverviewInput::Down)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[A", at(0)),
            Action::Panel(OverviewInput::Up)
        );
        assert_eq!(
            process_chunk(&mut s, b"r", at(0)),
            Action::Panel(OverviewInput::Refresh)
        );
        // Mouse scroll reaches the panel in both encodings.
        assert_eq!(
            process_chunk(&mut s, b"\x1b[<64;10;3M", at(0)),
            Action::Panel(OverviewInput::Up)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[<65;10;3M", at(0)),
            Action::Panel(OverviewInput::Down)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[M`ab", at(0)),
            Action::Panel(OverviewInput::Up)
        );
        assert_eq!(
            process_chunk(&mut s, b"\x1b[M`aa", at(0)),
            Action::Panel(OverviewInput::Up)
        );
        // Everything else is inert, never forwarded: herdr must not receive
        // stray bytes while it does not own focus.
        assert_eq!(process_chunk(&mut s, b"x", at(0)), Action::Ignore);
        assert_eq!(
            process_chunk(&mut s, b"\x1b[<0;1;1M", at(0)),
            Action::Ignore
        );
    }

    #[test]
    fn q_quits_only_from_panel_focus() {
        let mut s = state();
        assert_eq!(process_chunk(&mut s, b"q", at(0)), Action::Forward);
        process_chunk(&mut s, b"\x09", at(0));
        assert_eq!(
            process_chunk(&mut s, b"q", at(0)),
            Action::Panel(OverviewInput::Quit)
        );
    }

    #[test]
    fn ctrl_c_double_press_force_quits_within_a_second() {
        let mut s = state();
        let t0 = at(0);
        assert_eq!(process_chunk(&mut s, b"\x03", t0), Action::Forward);
        // Still inside the window (500ms later): force quit.
        assert_eq!(
            process_chunk(&mut s, b"\x03", t0 + Duration::from_millis(500)),
            Action::Quit
        );
    }

    #[test]
    fn ctrl_c_outside_the_window_is_two_singles_again() {
        let mut s = state();
        let t0 = at(0);
        assert_eq!(process_chunk(&mut s, b"\x03", t0), Action::Forward);
        // 2s later the arm has expired: forward again, not quit.
        assert_eq!(
            process_chunk(&mut s, b"\x03", t0 + Duration::from_secs(2)),
            Action::Forward
        );
        // And a fresh second press force-quits from there.
        assert_eq!(
            process_chunk(
                &mut s,
                b"\x03",
                t0 + Duration::from_secs(2) + Duration::from_millis(100)
            ),
            Action::Quit
        );
    }

    #[test]
    fn ctrl_c_is_forwarded_from_panel_focus_too() {
        let mut s = state();
        process_chunk(&mut s, b"\x09", at(0));
        assert_eq!(process_chunk(&mut s, b"\x03", at(0)), Action::Forward);
    }

    #[test]
    fn any_key_between_ctrl_c_presses_disarms_the_force_quit() {
        let mut s = state();
        let t0 = at(0);
        process_chunk(&mut s, b"\x03", t0);
        process_chunk(&mut s, b"a", t0 + Duration::from_millis(300));
        assert_eq!(
            process_chunk(&mut s, b"\x03", t0 + Duration::from_millis(500)),
            Action::Forward,
            "the double-press window was disarmed"
        );
    }

    #[test]
    fn tab_on_the_death_screen_still_toggles() {
        let mut s = state();
        s.child = ChildState::Exited(ExitInfo {
            code: Some(0),
            signal: None,
        });
        process_chunk(&mut s, b"\x09", at(0));
        assert_eq!(s.focus, Focus::Panel);
    }

    #[test]
    fn death_screen_answers_r_and_q_regardless_of_focus() {
        let mut s = state();
        s.focus = Focus::Panel;
        s.child = ChildState::Exited(ExitInfo {
            code: Some(1),
            signal: None,
        });
        assert_eq!(process_chunk(&mut s, b"r", at(0)), Action::Restart);
        assert_eq!(process_chunk(&mut s, b"q", at(0)), Action::Quit);
        // Panel scroll keys are inert on the death screen.
        assert_eq!(process_chunk(&mut s, b"j", at(0)), Action::Ignore);
        // And so is anything else.
        assert_eq!(process_chunk(&mut s, b"x", at(0)), Action::Ignore);
        // Tab still toggles (harmless, forward becomes a no-op).
        assert_eq!(process_chunk(&mut s, b"\x09", at(0)), Action::Ignore);
    }

    /* ------------------------------- status bar ------------------------------ */

    fn line_text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.to_string()).collect()
    }

    #[test]
    fn status_bar_shows_focus_state_and_label() {
        let s = state();
        let text = line_text(&status_line(&s, None, 200));
        assert!(text.contains("herdr"), "focus badge: {text}");
        assert!(text.contains("running"), "child state: {text}");
        assert!(text.contains("local"), "default label: {text}");
        // herdr has focus: q is herdr's, so the hint points at the panel.
        assert!(text.contains("tab: panel"), "tab hint: {text}");
        assert!(
            !text.contains("q quit"),
            "q must not be hinted while herdr owns keys: {text}"
        );

        let mut s = state();
        s.focus = Focus::Panel;
        let text = line_text(&status_line(&s, Some("remote:box"), 200));
        assert!(text.contains("panel"), "focus badge: {text}");
        assert!(text.contains("remote:box"), "remote label: {text}");
        assert!(text.contains("q quit"), "q quits from panel focus: {text}");
        assert!(text.contains("tab: herdr"), "tab-back hint: {text}");
    }

    #[test]
    fn status_bar_fits_its_width() {
        let s = state();
        for width in [40, 60, 80, 120, 200] {
            let text = line_text(&status_line(&s, Some("remote:herdr.dynacom.dev"), width));
            assert!(
                text.chars().count() <= width,
                "status bar overflows {width}: {text}"
            );
        }
    }

    #[test]
    fn status_bar_reports_the_death_screen_honestly() {
        let mut s = state();
        s.child = ChildState::Exited(ExitInfo {
            code: Some(3),
            signal: None,
        });
        let text = line_text(&status_line(&s, None, 200));
        assert!(text.contains("exited (code 3)"), "{text}");
        assert!(text.contains("r restart"), "{text}");
        assert!(text.contains("q quit"), "{text}");

        s.child = ChildState::Exited(ExitInfo {
            code: None,
            signal: Some("KILL".to_string()),
        });
        let text = line_text(&status_line(&s, None, 200));
        assert!(text.contains("killed by KILL"), "{text}");

        s.child = ChildState::Failed("no such file".to_string());
        let text = line_text(&status_line(&s, None, 200));
        assert!(text.contains("failed to start"), "{text}");
        assert!(text.contains("r retry"), "{text}");

        s.child = ChildState::Exited(ExitInfo {
            code: Some(0),
            signal: None,
        });
        let text = line_text(&status_line(&s, None, 200));
        assert!(text.contains("exited cleanly"), "{text}");
    }
}
