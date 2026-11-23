// A pending request_group approval, as the service worker, the side panel and the popup page see it.

export interface RequestInfo {
  agentLabel: string;
  identity: string;
  groupId: number;
  groupTitle: string;
  tabCount: number;
  allowClose: boolean;
  /** Another agent session made this group. */
  shared: boolean;
}

export interface PendingRequest extends RequestInfo {
  id: string;
  /** The consent sentence of the notification: what the agent may do with the tabs. */
  consent: string;
  /** Set when another agent session made the group. */
  note?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. The request ends as a timeout at this time. */
  deadline: number;
}

export const REQUEST_TITLE = "An agent asks to use a tab group";
export const NOTIFICATION_TITLE = "AIS Browser: allow an agent to use a tab group?";
export const SHARED_NOTE = "Another agent session made this group.";
/** How long the owner has to answer. */
export const PROMPT_WAIT_MS = 300_000;

export const consentText = (allowClose: boolean): string =>
  allowClose ? "The agent can read, use and CLOSE these tabs." : "The agent can read and use these tabs. It never closes them.";

/** The notification body. The card shows the same facts in separate lines. */
export function notificationMessage(i: RequestInfo): string {
  return `Agent "${i.agentLabel}" (identity ${i.identity}) asks to use the group "${i.groupTitle}" with ${i.tabCount} tabs.${i.shared ? ` ${SHARED_NOTE}` : ""} ${consentText(i.allowClose)}`;
}

/** "4:59 left", never negative. */
export function countdownText(deadline: number, now: number): string {
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

/** Messages between the pages and the worker. */
export const REQUESTS_CHANGED = "ais-requests-changed";
