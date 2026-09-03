//! HTTP access to the AIS Console API (see docs/API.md in the repository).

use std::time::Duration;

use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::config::Settings;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("request failed: {0}")]
    Transport(String),
    #[error("HTTP {status}: {body}")]
    Status { status: u16, body: String },
    #[error("invalid JSON response: {0}")]
    Parse(String),
}

pub struct ConsoleClient {
    http: reqwest::Client,
    settings: Settings,
}

impl ConsoleClient {
    pub fn new(settings: Settings) -> reqwest::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            // The console is loopback-only; honouring http_proxy/ALL_PROXY
            // env vars would route 127.0.0.1 through a proxy that cannot
            // reach it and produce a permanent "unreachable" banner.
            .no_proxy()
            .build()?;
        Ok(Self { http, settings })
    }

    /// Bearer token for this request: the explicit environment value when
    /// set, otherwise whatever the console's own server.json currently
    /// holds. A missing or unreadable file yields no header at all; the
    /// console still admits requests from loopback with a matching Host.
    fn token(&self) -> Option<String> {
        if let Some(token) = &self.settings.token {
            return Some(token.clone());
        }
        let text = std::fs::read_to_string(&self.settings.token_path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        value
            .get("token")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        let url = format!("{}{}", self.settings.base_url, path);
        let mut request = self.http.get(&url).header("X-AIS-Console", "1");
        if let Some(token) = self.token() {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|err| ApiError::Transport(err.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| ApiError::Transport(err.to_string()))?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: summarise_body(&body),
            });
        }
        serde_json::from_str(&body).map_err(|err| ApiError::Parse(err.to_string()))
    }
}

/// Keeps error surfaces short: one line, bounded length, so a huge HTML 502
/// body cannot blow out the TUI layout.
fn summarise_body(body: &str) -> String {
    let flat: String = body
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= 160 {
        flat.to_string()
    } else {
        let cut: String = flat.chars().take(157).collect();
        format!("{cut}...")
    }
}
