//! Tab 3: local llama.cpp models listed by the console. `Enter` starts the
//! first one (the run loop hands the terminal to `ais local start`).

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use crate::app::{App, TAB_LOCAL_MODELS};
use crate::models::LocalModelsResponse;
use crate::ui::widgets;

const NAME_W: usize = 26;
const SIZE_W: usize = 12;

pub fn render(f: &mut Frame<'_>, app: &mut App, area: Rect) {
    let block = widgets::panel("Local Models");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let lines = match &app.local_models.data {
        Some(data) => build_lines(data),
        None => vec![match app.local_models.error.as_deref() {
            Some(message) => widgets::error_line(message),
            None => widgets::loading_line("waiting for /api/local-models", app.frame),
        }],
    };

    let visible = usize::from(inner.height);
    widgets::clamp_scroll(&mut app.scrolls[TAB_LOCAL_MODELS], visible, lines.len());
    let offset = u16::try_from(app.scrolls[TAB_LOCAL_MODELS]).unwrap_or(u16::MAX);
    f.render_widget(Paragraph::new(Text::from(lines)).scroll((offset, 0)), inner);
}

/// Pure string-building so tests need no terminal.
pub fn build_lines(data: &LocalModelsResponse) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if !data.online {
        lines.push(Line::from(
            Span::from("Offline: cloud providers need internet")
                .yellow()
                .bold(),
        ));
    }
    if data.runner.is_none() {
        lines.push(Line::from(
            Span::from("llama.cpp runner missing").red().bold(),
        ));
    }
    if data.models.is_empty() {
        lines.push(Line::from(Span::from("No local model found").dark_gray()));
        return lines;
    }
    if !lines.is_empty() {
        lines.push(Line::default());
    }
    lines.push(Line::from(vec![
        Span::from(format!("  {:<NAME_W$}", "NAME"))
            .dark_gray()
            .bold(),
        Span::from(format!("{:<SIZE_W$}", "SIZE"))
            .dark_gray()
            .bold(),
        Span::from("PATH").dark_gray().bold(),
    ]));
    for model in &data.models {
        lines.push(Line::from(vec![
            Span::from(format!(
                "  {:<NAME_W$}",
                widgets::ellipsize(&model.name, NAME_W - 1)
            ))
            .bold(),
            Span::from(format!("{:<SIZE_W$}", human_size(model.size_bytes))),
            Span::from(model.path.clone()).dark_gray(),
        ]));
    }
    if data.models.len() > 1 {
        lines.push(Line::default());
        lines.push(Line::from(
            Span::from("Several models found: Enter starts the first one").dark_gray(),
        ));
    }
    lines
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LocalModelEntry;

    fn text(lines: &[Line]) -> String {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn offline_missing_runner_and_no_models_show_notes() {
        let out = text(&build_lines(&LocalModelsResponse::default()));
        assert!(out.contains("Offline: cloud providers need internet"));
        assert!(out.contains("llama.cpp runner missing"));
        assert!(out.contains("No local model found"));
    }

    #[test]
    fn online_model_lists_name_and_size() {
        let data = LocalModelsResponse {
            online: true,
            runner: Some("llama-cli".into()),
            models: vec![LocalModelEntry {
                name: "tiny".into(),
                path: "/synthetic/tiny.gguf".into(),
                size_bytes: 3 * 1024 * 1024,
            }],
        };
        let out = text(&build_lines(&data));
        assert!(out.contains("tiny") && out.contains("3.0 MiB"));
        assert!(!out.contains("Offline") && !out.contains("runner missing"));
    }
}
