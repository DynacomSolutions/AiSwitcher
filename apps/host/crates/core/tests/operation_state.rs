use ais_host_core::operation::{OperationError, OperationPhase, OperationView};

fn operation(id: &str, phase: OperationPhase) -> OperationView {
    OperationView {
        id: id.to_owned(),
        phase,
        completed_bytes: 0,
        total_bytes: Some(100),
        can_cancel: true,
        error_code: None,
    }
}

#[test]
fn rejects_progress_from_another_operation() {
    assert_eq!(
        operation("current", OperationPhase::Running)
            .apply_progress(&operation("other", OperationPhase::Running)),
        Err(OperationError::StaleProgress)
    );
}

#[test]
fn cancellation_preserves_a_completed_operation() {
    assert_eq!(
        operation("done", OperationPhase::Completed).cancel(),
        Err(OperationError::AlreadyCompleted)
    );
}

#[test]
fn progress_cannot_move_a_terminal_operation() {
    assert_eq!(
        operation("done", OperationPhase::Completed)
            .apply_progress(&operation("done", OperationPhase::Running)),
        Err(OperationError::AlreadyTerminal)
    );
}

#[test]
fn cancellation_respects_operation_capability() {
    let mut running = operation("uncancellable", OperationPhase::Running);
    running.can_cancel = false;
    assert_eq!(running.cancel(), Err(OperationError::CannotCancel));
}

#[test]
fn uncancellable_operations_still_accept_progress() {
    let mut current = operation("uncancellable", OperationPhase::Running);
    current.can_cancel = false;
    let mut progress = current.clone();
    progress.completed_bytes = 50;
    assert_eq!(current.apply_progress(&progress), Ok(progress));
}
