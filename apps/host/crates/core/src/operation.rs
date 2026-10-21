use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    pub id: String,
    pub phase: OperationPhase,
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub can_cancel: bool,
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationPhase {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl OperationPhase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum OperationError {
    #[error("progress belongs to a different operation")]
    StaleProgress,
    #[error("a completed operation cannot be cancelled")]
    AlreadyCompleted,
    #[error("operation is already terminal")]
    AlreadyTerminal,
    #[error("operation cannot be cancelled")]
    CannotCancel,
}

impl OperationView {
    pub fn apply_progress(&self, incoming: &Self) -> Result<Self, OperationError> {
        if self.id != incoming.id {
            return Err(OperationError::StaleProgress);
        }
        if self.phase.is_terminal() {
            return Err(OperationError::AlreadyTerminal);
        }
        Ok(incoming.clone())
    }

    pub fn cancel(&self) -> Result<Self, OperationError> {
        if self.phase == OperationPhase::Completed {
            return Err(OperationError::AlreadyCompleted);
        }
        if self.phase.is_terminal() {
            return Err(OperationError::AlreadyTerminal);
        }
        if !self.can_cancel {
            return Err(OperationError::CannotCancel);
        }
        let mut next = self.clone();
        next.phase = OperationPhase::Cancelling;
        next.can_cancel = false;
        Ok(next)
    }
}
