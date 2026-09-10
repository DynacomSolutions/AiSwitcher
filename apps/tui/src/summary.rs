//! Pure merge of the limits and usage endpoints into the per-identity,
//! per-provider rows the status page renders.
//!
//! The two endpoints answer at different cadences and either may be missing
//! (still loading or failed), so every input is optional and rows degrade
//! gracefully: a provider seen only in usage has cost figures but no limit
//! bar, and one seen only in limits has the opposite. Ordering is
//! deterministic (identity, then provider) so a refresh never reshuffles
//! rows the user is reading.

use std::collections::BTreeMap;

use crate::models::{LimitResult, LimitsResponse, OverageInfo, UsageResponse, UsageResult};

/// Provider-reported real billed spend. Distinct from tokscale's token
/// estimate: some providers confirm a dollar figure, others only a live
/// "drawing on extra usage" status, and many have no such concept at all
/// (see OverageInfo in src/cli/limits/types.ts).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RealSpend {
    /// Confirmed dollars billed this period, when the provider reports one.
    pub usd: Option<f64>,
    /// Configured monthly extra-usage spend cap, when known (only Kimi).
    pub limit_usd: Option<f64>,
    /// Known-nonzero extra-usage status with no figure behind it.
    pub active: bool,
    /// The provider's own status wording (e.g. "subscription only").
    pub label: Option<String>,
}

impl RealSpend {
    fn from_overage(info: &OverageInfo) -> Self {
        Self {
            usd: info.spent_usd,
            limit_usd: info.limit_usd,
            active: info.active.unwrap_or(false),
            label: info.label.clone(),
        }
    }

    /// True when the provider exposes any real-spend concept at all; false
    /// means "nothing reported", never "confirmed zero".
    pub fn is_reported(&self) -> bool {
        self.usd.is_some() || self.active || self.label.is_some()
    }
}

/// One provider's contribution to an identity's status row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProviderSummary {
    pub provider: String,
    /// Tokscale token-estimate cost across local history (never real spend).
    pub est_cost: Option<f64>,
    pub real: RealSpend,
    /// Worst (highest) window usage across the provider's windows.
    pub worst_percent: Option<f64>,
    /// The worst window's own reset text, pre-formatted by the adapter.
    pub next_reset: Option<String>,
    /// The worst window's status note (e.g. "credits depleted"), which
    /// usually matters more than the reset time.
    pub note: Option<String>,
    /// Manual reset credits the account can spend right now.
    pub manual_resets: Option<u64>,
    /// live | cached | unavailable | pending, from the limits fetch.
    pub limit_status: Option<String>,
    pub error: Option<String>,
}

impl ProviderSummary {
    /// True when the limits fetch answered for this provider at all; a
    /// usage-only row has no window data to show.
    pub fn has_limit_data(&self) -> bool {
        self.limit_status.is_some()
    }
}

/// All providers reporting for one identity, sorted by provider.
#[derive(Debug, Clone, PartialEq)]
pub struct IdentitySummary {
    pub identity: String,
    pub providers: Vec<ProviderSummary>,
}

type RowKey = (String, String);

fn key_of(identity: &str, provider: &str) -> RowKey {
    (identity.to_string(), provider.to_string())
}

/// Build the status rows from whichever endpoint payloads have arrived.
pub fn summarize(
    limits: Option<&LimitsResponse>,
    usage: Option<&UsageResponse>,
) -> Vec<IdentitySummary> {
    let mut rows: BTreeMap<RowKey, ProviderSummary> = BTreeMap::new();
    if let Some(limits) = limits {
        for result in &limits.results {
            apply_limits(&mut rows, result);
        }
    }
    if let Some(usage) = usage {
        for result in &usage.results {
            apply_usage(&mut rows, result);
        }
    }
    fold_into_identities(rows)
}

fn apply_limits(rows: &mut BTreeMap<RowKey, ProviderSummary>, result: &LimitResult) {
    let provider = result
        .provider
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let entry = rows
        .entry(key_of(result.identity.name(), &provider))
        .or_default();
    entry.provider = provider;
    entry.limit_status = result.status.clone();
    entry.error = result.error.clone();
    entry.manual_resets = result
        .manual_reset
        .as_ref()
        .and_then(|reset| reset.available_count)
        .filter(|count| *count > 0);
    if let Some(worst) =
        result
            .windows
            .iter()
            .max_by(|a, b| match (a.used_percent, b.used_percent) {
                (Some(a_pct), Some(b_pct)) => a_pct
                    .partial_cmp(&b_pct)
                    .unwrap_or(std::cmp::Ordering::Equal),
                (Some(_), None) => std::cmp::Ordering::Greater,
                (None, Some(_)) => std::cmp::Ordering::Less,
                (None, None) => std::cmp::Ordering::Equal,
            })
    {
        entry.worst_percent = worst.used_percent;
        entry.next_reset = worst.resets_at.clone();
        entry.note = worst.note.clone();
    }
    if let Some(overage) = &result.overage {
        entry.real = RealSpend::from_overage(overage);
    }
}

fn apply_usage(rows: &mut BTreeMap<RowKey, ProviderSummary>, result: &UsageResult) {
    let provider = result
        .provider
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let entry = rows
        .entry(key_of(result.identity.name(), &provider))
        .or_default();
    entry.provider = provider;
    entry.est_cost = result.report.as_ref().and_then(|report| report.total_cost);
    // The usage endpoint's overage probe is the dedicated real-spend source;
    // prefer it over whatever the limits scan contributed.
    if let Some(overage) = &result.extra_cost {
        entry.real = RealSpend::from_overage(overage);
    }
    // AWS Bedrock rows carry their real spend in `realCost` (Cost Explorer
    // month-to-date, plus the enforced budget's limit) instead of an overage
    // probe; it lands in the same REAL $ column. Only an ANSWERED query maps
    // here: an errored one must not overwrite the figure with a fake zero.
    if let Some(real_cost) = &result.real_cost
        && let Some(usd) = real_cost.month_to_date_usd
    {
        entry.real = RealSpend {
            usd: Some(usd),
            limit_usd: real_cost.budget_limit_usd,
            active: false,
            label: real_cost.note.clone(),
        };
    }
    if entry.error.is_none() {
        entry.error = result.error.clone();
    }
}

fn fold_into_identities(rows: BTreeMap<RowKey, ProviderSummary>) -> Vec<IdentitySummary> {
    let mut identities: Vec<IdentitySummary> = Vec::new();
    for ((identity, _provider), summary) in rows {
        match identities.last_mut() {
            Some(last) if last.identity == identity => last.providers.push(summary),
            _ => identities.push(IdentitySummary {
                identity,
                providers: vec![summary],
            }),
        }
    }
    identities
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{IdentityRef, LimitWindow, ManualResetInfo, TokscaleReport};

    fn limit_result(identity: &str, provider: &str) -> LimitResult {
        LimitResult {
            tool_name: None,
            provider: Some(provider.to_string()),
            identity: IdentityRef {
                name: Some(identity.to_string()),
            },
            windows: Vec::new(),
            status: Some("live".to_string()),
            error: None,
            captured_at: None,
            overage: None,
            manual_reset: None,
        }
    }

    fn window(pct: f64, reset: Option<&str>, note: Option<&str>) -> LimitWindow {
        LimitWindow {
            label: None,
            used_percent: Some(pct),
            resets_at: reset.map(str::to_string),
            note: note.map(str::to_string),
        }
    }

    fn usage_result(identity: &str, provider: &str, cost: f64) -> UsageResult {
        UsageResult {
            provider: Some(provider.to_string()),
            identity: IdentityRef {
                name: Some(identity.to_string()),
            },
            report: Some(TokscaleReport {
                total_cost: Some(cost),
                ..Default::default()
            }),
            error: None,
            extra_cost: None,
            real_cost: None,
            date_span: None,
        }
    }

    fn limits_response(results: Vec<LimitResult>) -> LimitsResponse {
        LimitsResponse { results }
    }

    fn usage_response(results: Vec<UsageResult>) -> UsageResponse {
        UsageResponse { results }
    }

    #[test]
    fn merges_limits_and_usage_per_identity_and_provider() {
        let mut claude = limit_result("work", "anthropic");
        claude.windows = vec![
            window(20.0, Some("Sep 14"), None),
            window(70.0, Some("Sep 15"), None),
        ];
        let mut codex = limit_result("work", "openai");
        codex.windows = vec![window(100.0, Some("Sep 16"), Some("credits depleted"))];
        let mut usage = usage_result("work", "anthropic", 12.5);
        usage.extra_cost = Some(OverageInfo {
            active: Some(true),
            label: Some("using extra usage".to_string()),
            spent_usd: None,
            limit_usd: None,
        });

        let rows = summarize(
            Some(&limits_response(vec![claude, codex])),
            Some(&usage_response(vec![
                usage,
                usage_result("work", "openai", 3.0),
            ])),
        );

        assert_eq!(rows.len(), 1);
        let identity = &rows[0];
        assert_eq!(identity.identity, "work");
        assert_eq!(identity.providers.len(), 2);
        let anthropic = &identity.providers[0];
        assert_eq!(anthropic.provider, "anthropic");
        assert_eq!(anthropic.est_cost, Some(12.5));
        assert_eq!(anthropic.worst_percent, Some(70.0));
        assert_eq!(anthropic.next_reset.as_deref(), Some("Sep 15"));
        assert!(anthropic.real.active);
        let openai = &identity.providers[1];
        assert_eq!(openai.worst_percent, Some(100.0));
        assert_eq!(openai.note.as_deref(), Some("credits depleted"));
        assert_eq!(openai.est_cost, Some(3.0));
    }

    #[test]
    fn keeps_usage_only_and_limits_only_rows() {
        let mut claude = limit_result("work", "anthropic");
        claude.windows = vec![window(45.0, None, None)];
        let rows = summarize(
            Some(&limits_response(vec![claude])),
            Some(&usage_response(vec![usage_result("home", "kimi", 4.2)])),
        );

        assert_eq!(rows.len(), 2);
        // Sorted by identity: "home" (usage-only) precedes "work" (limits-only).
        let home = &rows[0];
        assert_eq!(home.identity, "home");
        assert!(!home.providers[0].has_limit_data());
        assert_eq!(home.providers[0].est_cost, Some(4.2));
        let work = &rows[1];
        assert_eq!(work.identity, "work");
        assert!(work.providers[0].has_limit_data());
        assert_eq!(work.providers[0].est_cost, None);
    }

    #[test]
    fn manual_resets_surface_only_when_available() {
        let mut resettable = limit_result("work", "openai");
        resettable.manual_reset = Some(ManualResetInfo {
            available_count: Some(2),
        });
        let mut empty = limit_result("home", "openai");
        empty.manual_reset = Some(ManualResetInfo {
            available_count: Some(0),
        });
        let absent = limit_result("other", "openai");

        let rows = summarize(
            Some(&limits_response(vec![resettable, empty, absent])),
            None,
        );

        // Identities come back in deterministic (alphabetical) order.
        assert_eq!(rows[2].providers[0].manual_resets, Some(2));
        assert_eq!(rows[0].providers[0].manual_resets, None);
        assert_eq!(rows[1].providers[0].manual_resets, None);
    }

    #[test]
    fn usage_overage_wins_for_real_spend() {
        let mut claude = limit_result("work", "anthropic");
        claude.overage = Some(OverageInfo {
            active: Some(false),
            label: Some("cached probe".to_string()),
            spent_usd: None,
            limit_usd: None,
        });
        let mut usage = usage_result("work", "anthropic", 9.0);
        usage.extra_cost = Some(OverageInfo {
            active: Some(true),
            label: Some("using extra usage".to_string()),
            spent_usd: Some(4.2),
            limit_usd: Some(20.0),
        });

        let rows = summarize(
            Some(&limits_response(vec![claude])),
            Some(&usage_response(vec![usage])),
        );

        let real = &rows[0].providers[0].real;
        assert_eq!(real.usd, Some(4.2));
        assert_eq!(real.limit_usd, Some(20.0));
        assert!(real.is_reported());
    }

    #[test]
    fn unavailable_limit_keeps_error_and_windowless_row_renders() {
        let mut claude = limit_result("work", "anthropic");
        claude.status = Some("unavailable".to_string());
        claude.error = Some("not authenticated".to_string());
        let mut kimi = limit_result("home", "kimi");
        kimi.windows = Vec::new();

        let rows = summarize(Some(&limits_response(vec![claude, kimi])), None);

        // Sorted by identity: "home" (kimi) precedes "work" (claude).
        assert_eq!(
            rows[1].providers[0].error.as_deref(),
            Some("not authenticated")
        );
        assert_eq!(rows[0].providers[0].worst_percent, None);
        assert_eq!(rows[1].providers[0].worst_percent, None);
        assert!(rows[0].providers[0].has_limit_data());
    }

    #[test]
    fn ordering_is_deterministic() {
        let rows = summarize(
            Some(&limits_response(vec![
                limit_result("work", "openai"),
                limit_result("work", "anthropic"),
                limit_result("alpha", "zai"),
            ])),
            None,
        );

        let names: Vec<&str> = rows.iter().map(|r| r.identity.as_str()).collect();
        assert_eq!(names, vec!["alpha", "work"]);
        let providers: Vec<&str> = rows[1]
            .providers
            .iter()
            .map(|p| p.provider.as_str())
            .collect();
        assert_eq!(providers, vec!["anthropic", "openai"]);
    }

    #[test]
    fn both_missing_yields_no_rows() {
        assert!(summarize(None, None).is_empty());
    }

    #[test]
    fn real_spend_reported_only_when_provider_exposes_it() {
        assert!(!RealSpend::default().is_reported());
        assert!(
            RealSpend {
                usd: Some(0.0),
                ..Default::default()
            }
            .is_reported()
        );
    }

    #[test]
    fn bedrock_real_cost_lands_in_the_real_column_with_the_budget_limit() {
        let mut usage = usage_result("acme", "aws-bedrock", 2218.66);
        usage.real_cost = Some(crate::models::RealCostInfo {
            month_to_date_usd: Some(0.0),
            budget_limit_usd: Some(1000.0),
            note: Some("reported lag".to_string()),
        });

        let rows = summarize(None, Some(&usage_response(vec![usage])));

        let real = &rows[0].providers[0].real;
        assert_eq!(real.usd, Some(0.0));
        assert_eq!(real.limit_usd, Some(1000.0));
        assert!(!real.active);
        assert!(real.is_reported());
        assert_eq!(rows[0].providers[0].est_cost, Some(2218.66));
    }

    #[test]
    fn an_errored_bedrock_real_cost_never_fakes_a_zero_figure() {
        let mut usage = usage_result("acme", "aws-bedrock", 2218.66);
        // Only month_to_date_usd present makes the REAL column speak: a
        // payload without an answered figure maps to nothing at all.
        usage.real_cost = Some(crate::models::RealCostInfo {
            month_to_date_usd: None,
            budget_limit_usd: None,
            note: None,
        });

        let rows = summarize(None, Some(&usage_response(vec![usage])));

        assert!(!rows[0].providers[0].real.is_reported());
    }
}
