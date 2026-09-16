//! Embedded terminal host: the real herdr client runs as a child process in
//! its own PTY, its output is parsed by vt100, and the resulting grid is
//! rendered into any ratatui rect. This is the tmux replacement for the
//! `ais herdr` wrapper: one process, one region of one screen, no nested
//! multiplexer.
//!
//! Fidelity contract: keyboard, mouse and paste bytes from the real
//! terminal are forwarded to the PTY verbatim, and the terminal modes the
//! child enables on its own screen (mouse tracking, SGR encoding,
//! bracketed paste, application cursor/keypad) are mirrored onto the real
//! terminal so those bytes actually flow. Kitty-style graphics protocols
//! are not parsed by vt100 and degrade to blank rows: acceptable, herdr's
//! TUI is pure text.

use std::io::{Read, Write};

use anyhow::{Context, Result};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use tokio::sync::mpsc;

/* --------------------------------- events ---------------------------------- */

/// How the embedded child exited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Process exit code; None when killed by a signal.
    pub code: Option<i32>,
    /// Signal name when the child died to one.
    pub signal: Option<String>,
}

impl ExitInfo {
    pub fn describe(&self) -> String {
        match (self.code, &self.signal) {
            (Some(0), _) => "exited cleanly".to_string(),
            (Some(code), _) => format!("exited (code {code})"),
            (None, Some(signal)) => format!("killed by {signal}"),
            (None, None) => "exited".to_string(),
        }
    }
}

#[derive(Debug)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Exited(ExitInfo),
}

/* ------------------------------- child spec -------------------------------- */

/// How the child is launched; kept by the caller so it can restart it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl SpawnSpec {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
        }
    }

    fn command(&self) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        cmd.args(&self.args);
        // The child's output is parsed by vt100 and re-rendered as ratatui
        // styles, so it should speak a plain, well-supported xterm dialect
        // regardless of what the outer terminal calls itself (tmux sets
        // tmux-256color, ssh sessions something else again).
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd
    }
}

/* ------------------------------ embedded term ------------------------------ */

pub struct EmbeddedTerm {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    parser: vt100::Parser,
    pub cols: u16,
    pub rows: u16,
}

impl EmbeddedTerm {
    /// Spawns the child on a fresh PTY of `cols` x `rows` and wires the
    /// reader + waiter threads that feed `PtyEvent`s back.
    pub fn spawn(
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, mpsc::UnboundedReceiver<PtyEvent>)> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open a pty for the embedded terminal")?;
        let child = pair
            .slave
            .spawn_command(spec.command())
            .with_context(|| format!("failed to spawn {}", spec.program))?;
        let reader = pair
            .master
            .try_clone_reader()
            .context("failed to read from the pty master")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to write to the pty master")?;
        let killer = child.clone_killer();

        let (tx, rx) = mpsc::unbounded_channel::<PtyEvent>();

        // Reader: blocking reads bridged into the async event loop. Ends
        // when the pty closes (child exit or drop).
        let tx_reader = tx.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let tx = tx_reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(PtyEvent::Output(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Waiter: turns the child's exit into an event. The child itself is
        // moved in, so the only remaining handle is the killer.
        let tx2 = tx;
        std::thread::spawn(move || {
            let mut child = child;
            let info = match child.wait() {
                Ok(status) => {
                    if status.success() {
                        ExitInfo {
                            code: Some(0),
                            signal: None,
                        }
                    } else {
                        ExitInfo {
                            code: Some(status.exit_code() as i32),
                            signal: status.signal().map(str::to_string),
                        }
                    }
                }
                Err(err) => ExitInfo {
                    code: None,
                    signal: Some(err.to_string()),
                },
            };
            let _ = tx2.send(PtyEvent::Exited(info));
        });

        Ok((
            Self {
                master: pair.master,
                writer,
                killer,
                parser: vt100::Parser::new(rows, cols, 0),
                cols,
                rows,
            },
            rx,
        ))
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 || (cols == self.cols && rows == self.rows) {
            return Ok(());
        }
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize the pty")?;
        self.parser.screen_mut().set_size(rows, cols);
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    /// Raw bytes (keys, mouse reports, paste) straight to the child's
    /// stdin. Errors are swallowed: once the child is gone there is nothing
    /// to write to, and the exit event carries the news.
    pub fn write_input(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let _ = self.writer.write_all(bytes);
        let _ = self.writer.flush();
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// Feeds child output through the emulator. Call before sync_modes so
    /// the mirrored terminal modes track the child's screen.
    pub fn ingest(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    /// Draws the child's screen into `area`, clipped to whatever is
    /// smaller: the area or the child's grid. `show_cursor` renders the
    /// child's cursor position (it is the working surface's caret).
    pub fn render(&self, f: &mut Frame<'_>, area: Rect, show_cursor: bool) {
        render_screen(self.parser.screen(), f, area, show_cursor);
    }
}

/// Pure screen-to-buffer rendering, split from the PTY holder so tests can
/// drive it with synthetic bytes and no child process.
pub fn render_screen(screen: &vt100::Screen, f: &mut Frame<'_>, area: Rect, show_cursor: bool) {
    let (srows, scols) = screen.size();
    let buf = f.buffer_mut();
    for row in 0..area.height.min(srows) {
        for col in 0..area.width.min(scols) {
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };
            let position = (area.x + col, area.y + row);
            let mut modifier = Modifier::empty();
            if cell.bold() {
                modifier |= Modifier::BOLD;
            }
            if cell.dim() {
                modifier |= Modifier::DIM;
            }
            if cell.italic() {
                modifier |= Modifier::ITALIC;
            }
            if cell.underline() {
                modifier |= Modifier::UNDERLINED;
            }
            if cell.inverse() {
                modifier |= Modifier::REVERSED;
            }
            let style = Style::default()
                .fg(map_color(cell.fgcolor()))
                .bg(map_color(cell.bgcolor()))
                .add_modifier(modifier);
            // vt100 blanks (and the unused half of a wide character) are
            // empty strings; a ratatui cell must hold a space to keep the
            // buffer's cell-width arithmetic sane. ratatui's buffer diff
            // skips the trailing column of a wide symbol on its own.
            let contents = cell.contents();
            let symbol: &str = if contents.is_empty() { " " } else { contents };
            buf[position].set_symbol(symbol).set_style(style);
        }
    }
    if show_cursor && !screen.hide_cursor() {
        let (row, col) = screen.cursor_position();
        if row < area.height && col < area.width {
            f.set_cursor_position((area.x + col, area.y + row));
        }
    }
}

fn map_color(color: vt100::Color) -> Color {
    match color {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

/* ------------------------------ mode mirroring ----------------------------- */

/// The child-side terminal modes this wrapper mirrors onto the real
/// terminal. Without the mirror, bytes the real terminal should produce
/// (mouse reports, wrapped pastes, application-mode arrows) never flow, and
/// forwarding would silently drop them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MirroredModes {
    pub mouse_press: bool,
    pub mouse_button_motion: bool,
    pub mouse_any_motion: bool,
    pub mouse_sgr: bool,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
}

impl MirroredModes {
    pub const DEFAULT: Self = Self {
        mouse_press: false,
        mouse_button_motion: false,
        mouse_any_motion: false,
        mouse_sgr: false,
        bracketed_paste: false,
        application_cursor: false,
        application_keypad: false,
    };

    /// The sequences turning the real terminal from `current` into `self`:
    /// every changed mode contributes one enable or disable, all disables
    /// first, in a stable order so a tracking upgrade (say 1000 -> 1003)
    /// never leaves two tracking modes racing.
    pub fn sync_sequences(self, current: Self) -> Vec<&'static [u8]> {
        let fields = [
            (
                self.mouse_button_motion,
                current.mouse_button_motion,
                b"\x1b[?1002l".as_slice(),
                b"\x1b[?1002h".as_slice(),
            ),
            (
                self.mouse_any_motion,
                current.mouse_any_motion,
                b"\x1b[?1003l",
                b"\x1b[?1003h",
            ),
            (
                self.mouse_press,
                current.mouse_press,
                b"\x1b[?1000l",
                b"\x1b[?1000h",
            ),
            (
                self.mouse_sgr,
                current.mouse_sgr,
                b"\x1b[?1006l",
                b"\x1b[?1006h",
            ),
            (
                self.bracketed_paste,
                current.bracketed_paste,
                b"\x1b[?2004l",
                b"\x1b[?2004h",
            ),
            (
                self.application_cursor,
                current.application_cursor,
                b"\x1b[?1l",
                b"\x1b[?1h",
            ),
            (
                self.application_keypad,
                current.application_keypad,
                b"\x1b[?66l",
                b"\x1b[?66h",
            ),
        ];
        let mut out = Vec::new();
        for (target, was, off, _on) in fields {
            if !target && was {
                out.push(off);
            }
        }
        for (target, was, _off, on) in fields {
            if target && !was {
                out.push(on);
            }
        }
        out
    }
}

/// Reads the child's current modes out of its parsed screen.
pub fn mirrored_modes(screen: &vt100::Screen) -> MirroredModes {
    use vt100::MouseProtocolEncoding as E;
    use vt100::MouseProtocolMode as M;
    let mode = screen.mouse_protocol_mode();
    MirroredModes {
        mouse_press: matches!(mode, M::Press | M::PressRelease),
        mouse_button_motion: mode == M::ButtonMotion,
        mouse_any_motion: mode == M::AnyMotion,
        mouse_sgr: screen.mouse_protocol_encoding() == E::Sgr,
        bracketed_paste: screen.bracketed_paste(),
        application_cursor: screen.application_cursor(),
        application_keypad: screen.application_keypad(),
    }
}

/* ---------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::{Backend, ClearType, TestBackend};
    use ratatui::layout::Position;
    use ratatui::style::Modifier as M;

    /// A minimal backend that records whether the frame ended with a shown
    /// cursor (TestBackend cannot answer that: its position accessor keeps
    /// the last position even after hide_cursor).
    #[derive(Default)]
    struct RecordingBackend {
        buffer: ratatui::buffer::Buffer,
        cursor: Option<(u16, u16)>,
    }

    impl RecordingBackend {
        fn new(width: u16, height: u16) -> Self {
            Self {
                buffer: ratatui::buffer::Buffer::empty(Rect::new(0, 0, width, height)),
                cursor: None,
            }
        }
    }

    impl Backend for RecordingBackend {
        type Error = std::convert::Infallible;

        fn draw<'a, I>(&mut self, content: I) -> Result<(), Self::Error>
        where
            I: Iterator<Item = (u16, u16, &'a ratatui::buffer::Cell)>,
        {
            for (x, y, cell) in content {
                self.buffer[(x, y)] = cell.clone();
            }
            Ok(())
        }

        fn hide_cursor(&mut self) -> Result<(), Self::Error> {
            self.cursor = None;
            Ok(())
        }

        fn show_cursor(&mut self) -> Result<(), Self::Error> {
            self.cursor = Some(self.cursor.unwrap_or((0, 0)));
            Ok(())
        }

        fn get_cursor_position(&mut self) -> Result<Position, Self::Error> {
            Ok(self.cursor.unwrap_or((0, 0)).into())
        }

        fn set_cursor_position<P: Into<Position>>(
            &mut self,
            position: P,
        ) -> Result<(), Self::Error> {
            let p = position.into();
            self.cursor = Some((p.x, p.y));
            Ok(())
        }

        fn clear(&mut self) -> Result<(), Self::Error> {
            self.buffer.reset();
            Ok(())
        }

        fn clear_region(&mut self, region: ClearType) -> Result<(), Self::Error> {
            if region == ClearType::All {
                self.buffer.reset();
            }
            Ok(())
        }

        fn flush(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }

        fn size(&self) -> Result<ratatui::layout::Size, Self::Error> {
            Ok(self.buffer.area.as_size())
        }

        fn window_size(&mut self) -> Result<ratatui::backend::WindowSize, Self::Error> {
            Ok(ratatui::backend::WindowSize {
                columns_rows: self.buffer.area.as_size(),
                pixels: ratatui::layout::Size::ZERO,
            })
        }
    }

    /// Feeds bytes through a fresh 10x40 parser and renders the resulting
    /// screen into a full 10x40 test frame, returning the buffer plus the
    /// frame's final cursor state (None = hidden).
    fn rendered(bytes: &[u8], show_cursor: bool) -> (ratatui::buffer::Buffer, Option<(u16, u16)>) {
        let mut parser = vt100::Parser::new(10, 40, 0);
        parser.process(bytes);
        let screen = parser.screen().clone();
        let mut terminal =
            Terminal::new(RecordingBackend::new(40, 10)).expect("test backend is infallible");
        terminal
            .draw(|f| render_screen(&screen, f, Rect::new(0, 0, 40, 10), show_cursor))
            .expect("draw is infallible here");
        let cursor = terminal.backend().cursor;
        (terminal.backend().buffer.clone(), cursor)
    }

    fn row_text(buf: &ratatui::buffer::Buffer, y: u16, x0: u16, x1: u16) -> String {
        (x0..x1).map(|x| buf[(x, y)].symbol().to_string()).collect()
    }

    #[test]
    fn plain_text_lands_in_cells() {
        let (buf, _) = rendered(b"hello herdr", false);
        assert_eq!(row_text(&buf, 0, 0, 11), "hello herdr");
    }

    #[test]
    fn attributes_and_colours_survive_the_round_trip() {
        let (buf, _) = rendered(b"\x1b[1;31mRED\x1b[0m plain", false);
        let red = &buf[(0, 0)];
        assert_eq!(red.symbol(), "R");
        assert!(red.style().add_modifier.contains(M::BOLD));
        // vt100 has no named-colour model: SGR 31 arrives as palette index 1
        // and renders with the terminal's own palette.
        assert_eq!(red.style().fg, Some(Color::Indexed(1)));
        let plain = &buf[(3, 0)];
        assert_eq!(plain.style().fg, Some(Color::Reset));
        assert_eq!(plain.style().add_modifier, M::empty());
    }

    #[test]
    fn truecolor_and_indexed_colours_map() {
        let (buf, _) = rendered(b"\x1b[38;2;12;34;56mX\x1b[0m\x1b[38;5;196mY", false);
        assert_eq!(buf[(0, 0)].style().fg, Some(Color::Rgb(12, 34, 56)));
        assert_eq!(buf[(1, 0)].style().fg, Some(Color::Indexed(196)));
    }

    #[test]
    fn alternate_screen_content_is_what_renders() {
        // Enter alt screen, draw a frame, leave: the wrapper must show what
        // a real terminal would show at that moment, i.e. the last screen.
        let (buf, _) = rendered(b"\x1b[?1049h\x1b[2J\x1b[Halt frame\x1b[?1049lbye", false);
        assert_eq!(row_text(&buf, 0, 0, 10).trim_end(), "bye");
    }

    #[test]
    fn inverse_and_underline_render() {
        let (buf, _) = rendered(b"\x1b[7;4mIU\x1b[0m", false);
        assert!(buf[(0, 0)].style().add_modifier.contains(M::REVERSED));
        assert!(buf[(0, 0)].style().add_modifier.contains(M::UNDERLINED));
    }

    #[test]
    fn cursor_follows_the_child_and_respects_hide() {
        // Cursor parked at (row 3, col 5) by CUP: frame cursor must match.
        let (_, cursor) = rendered(b"\x1b[3;5H", true);
        assert_eq!(cursor, Some((4, 2)), "frame cursor is (x=col, y=row)");
        // Hidden cursor (DECTCEM off) never shows, even with show_cursor.
        let (_, cursor) = rendered(b"\x1b[?25lhidden", true);
        assert_eq!(cursor, None);
        // show_cursor=false (panel focus) never shows one either.
        let (_, cursor) = rendered(b"visible", false);
        assert_eq!(cursor, None);
    }

    #[test]
    fn oversized_grid_is_clipped_to_the_area() {
        let mut parser = vt100::Parser::new(10, 40, 0);
        parser.process(b"\x1b[1;1Htop\x1b[10;1H\x1b[38;5;196mlast");
        let screen = parser.screen().clone();
        let mut terminal = Terminal::new(TestBackend::new(20, 5)).unwrap();
        terminal
            .draw(|f| render_screen(&screen, f, Rect::new(0, 0, 20, 5), false))
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        assert_eq!(row_text(&buf, 0, 0, 4), "top ");
        // Row 9 of the child never fits a 5-row area.
        assert_eq!(row_text(&buf, 4, 0, 4), "    ");
    }

    #[test]
    fn offset_area_is_respected() {
        let mut parser = vt100::Parser::new(10, 40, 0);
        parser.process(b"\x1b[1;1Hcorner");
        let screen = parser.screen().clone();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        terminal
            .draw(|f| render_screen(&screen, f, Rect::new(5, 3, 30, 6), false))
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        assert_eq!(row_text(&buf, 3, 5, 11), "corner");
    }

    #[test]
    fn wide_characters_render_without_corrupting_the_following_cell() {
        let (buf, _) = rendered("漢字".as_bytes(), false);
        assert_eq!(buf[(0, 0)].symbol(), "漢");
        assert_eq!(buf[(1, 0)].symbol(), " ", "continuation half renders blank");
        assert_eq!(buf[(2, 0)].symbol(), "字");
    }

    /* ------------------------------ mode mirroring ------------------------------ */

    fn screen_for(bytes: &[u8]) -> vt100::Screen {
        let mut parser = vt100::Parser::new(10, 40, 0);
        parser.process(bytes);
        parser.screen().clone()
    }

    #[test]
    fn a_quiet_child_mirrors_nothing() {
        let modes = mirrored_modes(&screen_for(b"plain"));
        assert_eq!(modes, MirroredModes::DEFAULT);
        assert!(modes.sync_sequences(MirroredModes::DEFAULT).is_empty());
    }

    #[test]
    fn mouse_tracking_and_sgr_are_mirrored() {
        let modes = mirrored_modes(&screen_for(b"\x1b[?1000h\x1b[?1006h"));
        assert!(modes.mouse_press);
        assert!(modes.mouse_sgr);
        assert!(!modes.mouse_any_motion);
        let seq = modes.sync_sequences(MirroredModes::DEFAULT);
        assert_eq!(seq, vec![&b"\x1b[?1000h"[..], &b"\x1b[?1006h"[..]]);
        // Already in sync: no bytes at all.
        assert!(modes.sync_sequences(modes).is_empty());
    }

    #[test]
    fn press_release_counts_as_press_tracking() {
        let modes = mirrored_modes(&screen_for(b"\x1b[?1000h")); // VT200 press+release
        assert!(modes.mouse_press);
        assert!(!modes.mouse_button_motion);
    }

    #[test]
    fn motion_upgrade_disables_the_lower_mode_first() {
        let target = MirroredModes {
            mouse_any_motion: true,
            ..MirroredModes::DEFAULT
        };
        assert_eq!(
            target.sync_sequences(MirroredModes::DEFAULT),
            vec![&b"\x1b[?1003h"[..]]
        );
        // Dropping back must clear 1003 before 1000 comes back.
        let back = MirroredModes {
            mouse_press: true,
            ..MirroredModes::DEFAULT
        };
        assert_eq!(
            back.sync_sequences(target),
            vec![&b"\x1b[?1003l"[..], &b"\x1b[?1000h"[..]]
        );
    }

    #[test]
    fn paste_and_cursor_modes_are_mirrored_too() {
        let modes = mirrored_modes(&screen_for(b"\x1b[?2004h\x1b[?1h\x1b="));
        assert!(modes.bracketed_paste);
        assert!(modes.application_cursor);
        assert!(modes.application_keypad);
        let seq = modes.sync_sequences(MirroredModes::DEFAULT);
        assert_eq!(
            seq,
            vec![&b"\x1b[?2004h"[..], &b"\x1b[?1h"[..], &b"\x1b[?66h"[..],]
        );
        // Full teardown emits only disables, in reverse-safe order.
        let seq = MirroredModes::DEFAULT.sync_sequences(modes);
        assert_eq!(
            seq,
            vec![&b"\x1b[?2004l"[..], &b"\x1b[?1l"[..], &b"\x1b[?66l"[..],]
        );
    }

    /* ------------------------------ process tests ------------------------------ */

    #[test]
    fn spawn_resize_and_kill_round_trip() {
        let spec = SpawnSpec::new("/bin/cat", vec![]);
        let (mut term, mut rx) = EmbeddedTerm::spawn(spec.clone(), 40, 10).unwrap();
        term.write_input(b"hello");
        // echo back proves the PTY plumbing carries input both directions.
        let mut got_output = false;
        for _ in 0..50 {
            match rx.blocking_recv() {
                Some(PtyEvent::Output(bytes)) if bytes.contains(&b'o') => {
                    got_output = true;
                    break;
                }
                Some(_) => continue,
                None => break,
            }
        }
        assert!(got_output, "cat never echoed the written bytes back");
        term.resize(30, 8).unwrap();
        assert_eq!((term.cols, term.rows), (30, 8));
        assert_eq!(term.screen().size(), (8, 30));
        term.kill();
        let mut exited = false;
        for _ in 0..50 {
            match rx.blocking_recv() {
                Some(PtyEvent::Exited(_)) => {
                    exited = true;
                    break;
                }
                Some(_) => continue,
                None => break,
            }
        }
        assert!(exited, "kill() must produce an Exited event");
    }

    /* --------------------------------- exit info -------------------------------- */

    #[test]
    fn exit_info_describes_codes_and_signals() {
        assert_eq!(
            ExitInfo {
                code: Some(0),
                signal: None
            }
            .describe(),
            "exited cleanly"
        );
        assert_eq!(
            ExitInfo {
                code: Some(1),
                signal: None
            }
            .describe(),
            "exited (code 1)"
        );
        assert_eq!(
            ExitInfo {
                code: None,
                signal: Some("TERM".to_string())
            }
            .describe(),
            "killed by TERM"
        );
        assert_eq!(
            ExitInfo {
                code: None,
                signal: None
            }
            .describe(),
            "exited"
        );
    }
}
