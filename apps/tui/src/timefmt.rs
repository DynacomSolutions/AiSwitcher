//! Time formatting helpers: relative times, durations, compact dates.

use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};

pub fn now_ms() -> i64 {
    Timestamp::now().as_millisecond()
}

pub fn clock_now() -> String {
    Zoned::now().strftime("%H:%M:%S").to_string()
}

fn parse_ts(text: &str) -> Option<Timestamp> {
    text.trim().parse::<Timestamp>().ok()
}

/// Epoch milliseconds from an RFC3339 string, if it parses.
pub fn parse_to_ms(text: &str) -> Option<i64> {
    parse_ts(text).map(|ts| ts.as_millisecond())
}

/// "3m ago" / "in 2h" from an ISO timestamp string; returns the input
/// unchanged when it cannot be parsed so bad data stays visible.
pub fn rel_from_str(text: &str, now_ms: i64) -> String {
    match parse_ts(text) {
        Some(ts) => rel_from_ms(ts.as_millisecond(), now_ms),
        None => text.to_string(),
    }
}

/// Relative time from epoch milliseconds (accepts seconds-shaped values too,
/// since some upstream stores disagree about the unit).
pub fn rel_from_ms(ms: i64, now_ms: i64) -> String {
    // Anything below 1e10 cannot be milliseconds for any plausible date
    // (1e10 ms is April 1970), so treat it as epoch seconds.
    let normalised = if ms.abs() < 10_000_000_000 {
        ms * 1000
    } else {
        ms
    };
    let delta_s = (now_ms - normalised) / 1000;
    if delta_s == 0 {
        return "just now".to_string();
    }
    let past = delta_s > 0;
    let s = delta_s.unsigned_abs();
    let body = human_duration(s);
    if body == "just now" {
        return body;
    }
    if past {
        format!("{body} ago")
    } else {
        format!("in {body}")
    }
}

/// Compact duration: "3d 4h", "2h 15m", "5m 30s", "45s".
pub fn human_duration(secs: u64) -> String {
    let d = secs / 86_400;
    let h = (secs % 86_400) / 3_600;
    let m = (secs % 3_600) / 60;
    let s = secs % 60;
    if secs < 10 {
        "just now".to_string()
    } else if d >= 2 {
        format!("{d}d {h}h")
    } else if h >= 2 {
        format!("{h}h {m}m")
    } else if m >= 2 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

/// Short local date, e.g. "25 Aug", from epoch milliseconds.
pub fn short_date_ms(ms: i64) -> String {
    Timestamp::from_millisecond(ms)
        .ok()
        .map(|ts| ts.to_zoned(TimeZone::system()))
        .map(|zoned| zoned.strftime("%d %b").to_string())
        .unwrap_or_else(|| "-".to_string())
}
