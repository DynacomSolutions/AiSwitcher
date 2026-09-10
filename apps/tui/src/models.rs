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
    /// Canonical upstream provider (the provider-first grouping key, already
    /// resolved server-side, e.g. "anthropic", "openai", "opencode-go").
    #[serde(default)]
    pub provider: Option<String>,
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
    #[serde(default, rename = "manualReset", alias = "manual_reset")]
    pub manual_reset: Option<ManualResetInfo>,
}

/// Mirrors ManualResetInfo from src/cli/limits/types.ts: a reset credit the
/// account can spend right now, present only when at least one is available.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ManualResetInfo {
    #[serde(default, rename = "availableCount", alias = "available_count")]
    pub available_count: Option<u64>,
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
    /// Provider-reported real billed spend (see OverageInfo), distinct from
    /// the report's token-estimate cost.
    #[serde(default, rename = "extraCost", alias = "extra_cost")]
    pub extra_cost: Option<OverageInfo>,
    /// AWS Bedrock only: REAL AWS-reported spend (Cost Explorer month-to-date
    /// plus the enforced budget's limit), separate from the token estimate in
    /// `report.totalCost`. Maps into the same REAL $ column as extra_cost.
    #[serde(default, rename = "realCost", alias = "real_cost")]
    pub real_cost: Option<RealCostInfo>,
    #[serde(default, rename = "dateSpan", alias = "date_span")]
    pub date_span: Option<DateSpan>,
}

/// Mirrors RealCostInfo from src/cli/usage/aws-bedrock-usage.ts: every
/// dollar comes from AWS's own billing plane, never an estimate. Only the
/// fields this view reads are typed; the payload's windowUsd/budgetActualUsd
/// and any future additions pass through serde untouched.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RealCostInfo {
    #[serde(default, rename = "monthToDateUsd", alias = "month_to_date_usd")]
    pub month_to_date_usd: Option<f64>,
    #[serde(default, rename = "budgetLimitUsd", alias = "budget_limit_usd")]
    pub budget_limit_usd: Option<f64>,
    #[serde(default)]
    pub note: Option<String>,
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

/* Breakdown (per tool call) */

#[derive(Debug, Clone, Default, Deserialize)]
pub struct BreakdownResponse {
    #[serde(default)]
    pub results: Vec<BreakdownResult>,
}

/// Mirrors BreakdownResult from src/cli/usage/breakdown.ts.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BreakdownResult {
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default, rename = "windowDays", alias = "window_days")]
    pub window_days: Option<u64>,
    #[serde(default, rename = "filesRead", alias = "files_read")]
    pub files_read: Option<u64>,
    #[serde(default)]
    pub categories: Vec<BreakdownCategory>,
    #[serde(default)]
    pub unavailable: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Mirrors BreakdownCategory. Detail-only fields (per-tool rows, cache
/// writes) are not rendered by this view and stay untyped.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BreakdownCategory {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "callCount", alias = "call_count")]
    pub call_count: Option<f64>,
    #[serde(default, rename = "inputTokens", alias = "input_tokens")]
    pub input_tokens: Option<f64>,
    #[serde(default, rename = "outputTokens", alias = "output_tokens")]
    pub output_tokens: Option<f64>,
    #[serde(default, rename = "estCostUsd", alias = "est_cost_usd")]
    pub est_cost_usd: Option<f64>,
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
