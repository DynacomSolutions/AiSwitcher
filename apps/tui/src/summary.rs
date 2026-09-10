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
