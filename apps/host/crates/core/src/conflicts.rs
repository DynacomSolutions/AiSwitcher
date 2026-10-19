//! Three-way comparison of B's canonical configuration hashes. Missing entries
//! never request deletion. B v1 has no conditional host overwrite token.

use crate::contract::{BundleEntry, PathClass};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    KeepDrive,
    UseSource,
    #[default]
    Defer,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    pub class: PathClass,
    pub common_hash: Option<String>,
    pub source_hash: Option<String>,
    pub drive_hash: Option<String>,
    pub choice: ConflictChoice,
    pub reason: ConflictReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictReason {
    Diverged,
    MissingBaseline,
    StaleOutbox,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConfigAnalysis {
    pub include: BTreeSet<String>,
    pub retain: BTreeSet<String>,
    pub conflicts: Vec<Conflict>,
}

pub fn analyse(
    source: &[BundleEntry],
    drive: &[BundleEntry],
    common: &BTreeMap<String, String>,
    outbox_current: bool,
) -> ConfigAnalysis {
    let mut result = ConfigAnalysis::default();
    let drive: BTreeMap<_, _> = drive
        .iter()
        .filter(|entry| entry.class.is_config())
        .map(|entry| (entry.path.as_str(), entry.sha256.as_str()))
        .collect();
    for entry in source.iter().filter(|entry| entry.class.is_config()) {
        let current = drive.get(entry.path.as_str()).copied();
        let baseline = common.get(&entry.path).map(String::as_str);
        let conflict = if !outbox_current {
            Some(ConflictReason::StaleOutbox)
        } else if current == Some(&entry.sha256) {
            result.retain.insert(entry.path.clone());
            None
        } else if baseline.is_none() || current.is_none() {
            Some(ConflictReason::MissingBaseline)
        } else if current == baseline {
            result.include.insert(entry.path.clone());
            None
        } else if baseline == Some(&entry.sha256) {
            result.retain.insert(entry.path.clone());
            None
        } else {
            Some(ConflictReason::Diverged)
        };
        if let Some(reason) = conflict {
            result.conflicts.push(Conflict {
                path: entry.path.clone(),
                class: entry.class,
                common_hash: baseline.map(str::to_owned),
                source_hash: Some(entry.sha256.clone()),
                drive_hash: current.map(str::to_owned),
                choice: ConflictChoice::Defer,
                reason,
            });
        }
    }
    result
}

/// All choices are recorded for review, but UseSource is still deferred. Only
/// an agreed, tested B conditional-write contract can change that behaviour.
pub fn apply_choices(
    analysis: &mut ConfigAnalysis,
    choices: &BTreeMap<String, ConflictChoice>,
) -> Result<(), String> {
    if choices
        .keys()
        .any(|path| !analysis.conflicts.iter().any(|c| &c.path == path))
    {
        return Err("configuration choices do not match this preview".into());
    }
    for conflict in &mut analysis.conflicts {
        conflict.choice = choices.get(&conflict.path).copied().unwrap_or_default();
        if conflict.choice == ConflictChoice::KeepDrive {
            analysis.retain.insert(conflict.path.clone());
        }
    }
    Ok(())
}
