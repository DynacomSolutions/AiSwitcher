//! Tab 5: resumable sessions for the console's default cwd, grouped per
//! tool and identity. Scrollable.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use crate::app::App;
use crate::models::ToolResumeGroup;
use crate::timefmt;
use crate::ui::widgets;

const TAB_INDEX: usize = 4;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Sessions");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let lines: Vec<Line> = match &app.sessions.data {
        Some(data) => {
            let now_ms = timefmt::now_ms();
            let mut lines = Vec::new();
            let mut any = false;
            for group in &data.results {
                any |= push_group(&mut lines, group, now_ms);
            }
            if !any {
                lines.push(Line::from(
                    Span::from("no sessions recorded yet for this directory").dark_gray(),
                ));
            }
            lines
        }
        None => match app.sessions.error.as_deref() {
            Some(message) => vec![widgets::error_line(message)],
            None => vec![widgets::loading_line(
                "waiting for /api/sessions",
                app.frame,
            )],
        },
    };

    let visible = usize::from(inner.height);
    widgets::clamp_scroll(&mut app.scrolls[TAB_INDEX], visible, lines.len());
    let offset = u16::try_from(app.scrolls[TAB_INDEX]).unwrap_or(u16::MAX);
    f.render_widget(Paragraph::new(Text::from(lines)).scroll((offset, 0)), inner);
}

/// Returns whether the group contributed anything visible.
fn push_group(lines: &mut Vec<Line<'static>>, group: &ToolResumeGroup, now_ms: i64) -> bool {
    if group.sessions.is_empty() && group.error.is_none() {
        return false; // "never used this tool here" is not worth a header
    }
    let tool = group.tool_name.clone().unwrap_or_else(|| "?".to_string());
    let identity = group.identity.name().to_string();
    lines.push(Line::from(vec![
        Span::from(format!("{tool} · {identity} ")).cyan().bold(),
        Span::from(format!("({})", group.sessions.len())).dark_gray(),
    ]));

    let mut sessions = group.sessions.clone();
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(
            session
                .last_active_at
                .as_deref()
                .and_then(timefmt::parse_to_ms)
                .unwrap_or(0),
        )
    });
    for session in sessions {
        let label = widgets::ellipsize(session.label.as_deref().unwrap_or("untitled"), 46);
        let short_id = session
            .session_id
            .as_deref()
            .map(|id| id.chars().take(8).collect::<String>())
            .unwrap_or_default();
        let rel = session
            .last_active_at
            .as_deref()
            .map(|at| timefmt::rel_from_str(at, now_ms))
            .unwrap_or_else(|| "-".to_string());
        lines.push(Line::from(vec![
            Span::from(format!("  {label}")),
            Span::from(format!("  #{short_id}")).dark_gray(),
            Span::from(format!("  {rel}")).dark_gray(),
        ]));
    }
    if let Some(error) = &group.error {
        lines.push(Line::from(Span::from(format!("  error: {error}")).red()));
    }
    true
}
