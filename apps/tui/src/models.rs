//! Typed views of the console API responses.
//!
//! Every field is optional or defaulted on purpose: the console proxies
//! several CLI JSON shapes whose fields have grown over time, and a missing
//! or unexpectedly typed field must degrade to "not shown" instead of
//! failing the whole poll.

use serde::Deserialize;

/// Identity reference embedded in limits/usage/sessions results (the CLI
/// serialises the full Identity object, not just its name).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct IdentityRef {
    #[serde(default)]
    pub name: Option<String>,
}

impl IdentityRef {
    pub fn name(&self) -> &str {
        self.name.as_deref().unwrap_or("?")
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Status {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default, rename = "uptimeS", alias = "uptime_s")]
    pub uptime_s: Option<u64>,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default, rename = "aisHome", alias = "ais_home")]
    pub ais_home: Option<String>,
    #[serde(default)]
    pub tools: Vec<ToolInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ToolInfo {
    #[serde(default, rename = "toolName", alias = "tool_name")]
    pub tool_name: Option<String>,
    #[serde(default, rename = "realBinaryName", alias = "real_binary_name")]
    pub real_binary_name: Option<String>,
    #[serde(default, rename = "registryExists", alias = "registry_exists")]
    pub registry_exists: Option<bool>,
    /// Resolved real binary; the API documents null when not found.
    #[serde(default, rename = "binaryPath", alias = "binary_path")]
    pub binary_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Processes {
    #[serde(default)]
    pub processes: Vec<ProcessRow>,
    #[serde(default, rename = "scannedAt", alias = "scanned_at")]
    pub scanned_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProcessRow {
    #[serde(default)]
    pub pid: Option<i64>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default, rename = "startedAt", alias = "started_at")]
    pub started_at: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct IdentitiesResponse {
    #[serde(default)]
    pub registries: Vec<Registry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Registry {
    #[serde(default, rename = "toolName", alias = "tool_name")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub identities: Vec<IdentityEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct IdentityEntry {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, rename = "configDir", alias = "config_dir")]
    pub config_dir: Option<String>,
    #[serde(default, rename = "configDirExists", alias = "config_dir_exists")]
    pub config_dir_exists: Option<bool>,
    #[serde(default)]
    pub directories: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LimitsResponse {
    #[serde(default)]
    pub results: Vec<LimitResult>,
}

/// Mirrors ToolLimitResult from src/cli/limits/types.ts.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LimitResult {
    #[serde(default, rename = "toolName", alias = "tool_name", alias = "tool")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub identity: IdentityRef,
    #[serde(default)]
    pub windows: Vec<LimitWindow>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default, rename = "capturedAt", alias = "captured_at")]
    pub captured_at: Option<String>,
    #[serde(default)]
    pub overage: Option<OverageInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LimitWindow {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, rename = "usedPercent", alias = "used_percent")]
    pub used_percent: Option<f64>,
    /// Already human-formatted by each CLI adapter before it reaches us.
    #[serde(default, rename = "resetsAt", alias = "resets_at")]
    pub resets_at: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct OverageInfo {
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, rename = "spentUsd", alias = "spent_usd")]
    pub spent_usd: Option<f64>,
    #[serde(default, rename = "limitUsd", alias = "limit_usd")]
    pub limit_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UsageResponse {
    #[serde(default)]
    pub results: Vec<UsageResult>,
}

/// Mirrors UsageResult from src/cli/usage/run.ts after usageResultsForJson().
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UsageResult {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub identity: IdentityRef,
    #[serde(default)]
    pub report: Option<TokscaleReport>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default, rename = "dateSpan", alias = "date_span")]
    pub date_span: Option<DateSpan>,
}

/// Totals only: tokscale's per-model entries are not rendered by this view.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TokscaleReport {
    #[serde(default, rename = "totalInput", alias = "total_input")]
    pub total_input: Option<f64>,
    #[serde(default, rename = "totalOutput", alias = "total_output")]
    pub total_output: Option<f64>,
    #[serde(default, rename = "totalCacheRead", alias = "total_cache_read")]
    pub total_cache_read: Option<f64>,
    #[serde(default, rename = "totalCacheWrite", alias = "total_cache_write")]
    pub total_cache_write: Option<f64>,
    #[serde(default, rename = "totalCost", alias = "total_cost")]
    pub total_cost: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DateSpan {
    #[serde(default, rename = "firstMs", alias = "first_ms")]
    pub first_ms: Option<i64>,
    #[serde(default, rename = "lastMs", alias = "last_ms")]
    pub last_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SessionsResponse {
    #[serde(default)]
    pub results: Vec<ToolResumeGroup>,
}

/// Mirrors ToolResumeResult from src/cli/resume/types.ts.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ToolResumeGroup {
    #[serde(default, rename = "toolName", alias = "tool_name")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub identity: IdentityRef,
    #[serde(default)]
    pub sessions: Vec<SessionRow>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SessionRow {
    #[serde(default, rename = "sessionId", alias = "session_id")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, rename = "lastActiveAt", alias = "last_active_at")]
    pub last_active_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthResponse {
    #[serde(default)]
    pub entries: Vec<AuthEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthEntry {
    #[serde(default, rename = "toolName", alias = "tool_name")]
    pub tool_name: Option<String>,
    /// Plain identity name on this endpoint, per docs/API.md.
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub fixable: Vec<String>,
}
