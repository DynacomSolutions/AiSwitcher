import type { OperationView } from "./contract";

const terminalPhases = new Set(["completed", "failed", "cancelled"]);

export function acceptOperationProgress(current: OperationView | null, incoming: OperationView): OperationView | null {
  if (current === null) return incoming;
  if (current.id !== incoming.id || terminalPhases.has(current.phase)) return current;
  return incoming;
}
