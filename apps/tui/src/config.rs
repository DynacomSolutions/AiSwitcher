//! Resolution of console connection settings from the environment.

use std::env;
use std::path::PathBuf;

use anyhow::Result;

const DEFAULT_URL: &str = "http://127.0.0.1:47129";

#[derive(Debug, Clone)]
pub struct Settings {
    /// Console root URL, never with a trailing slash.
    pub base_url: String,
    /// Explicit token from AIS_CONSOLE_TOKEN. When absent, the client reads
    /// the token out of `token_path` on every request so a console restart
    /// (which rotates the per-boot token) heals itself without attention.
    pub token: Option<String>,
    /// Where the per-boot bearer token lives when no explicit token is set.
    pub token_path: PathBuf,
}

impl Settings {
    pub fn load() -> Result<Self> {
        let base_url = env::var("AIS_CONSOLE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        let token = env::var("AIS_CONSOLE_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let token_path = home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".ais/web/server.json");
        Ok(Self {
            base_url,
            token,
            token_path,
        })
    }

    /// Human-readable description of the token source for the help screen.
    /// Never includes the token value itself.
    pub fn describe_token_source(&self) -> String {
        match &self.token {
            Some(_) => "AIS_CONSOLE_TOKEN environment variable".to_string(),
            None => format!("{}", self.token_path.display()),
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}
