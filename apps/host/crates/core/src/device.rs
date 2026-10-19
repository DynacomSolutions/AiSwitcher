use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub id: String,
    pub display_identifier: String,
    pub model: Option<String>,
    pub capacity_bytes: u64,
    pub transport: String,
    pub system: bool,
    pub writable: bool,
    pub layout_status: String,
}
