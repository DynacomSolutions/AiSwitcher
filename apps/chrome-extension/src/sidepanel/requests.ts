// Wires the approval cards to the worker: a pending list, answers, live changes and a countdown.
import { createRequestView } from "../shared/request-card.ts";
import { REQUESTS_CHANGED } from "../shared/request.ts";
import type { PendingRequest } from "../shared/request.ts";

export function initRequests(root: HTMLElement, opts: { only?: string; onEmpty?: () => void } = {}): void {
  const view = createRequestView({
    doc: document,
    root,
    fetch: async () => ((await chrome.runtime.sendMessage({ type: "ais-requests" })) as PendingRequest[] | undefined) ?? [],
    answer: (id, approve) => chrome.runtime.sendMessage({ type: "ais-request-answer", id, approve }),
    now: () => Date.now(),
    ...(opts.only !== undefined ? { only: opts.only } : {}),
    ...(opts.onEmpty ? { onEmpty: opts.onEmpty } : {}),
  });
  void view.refresh();
  chrome.runtime.onMessage.addListener(msg => { if ((msg as { type?: unknown } | null)?.type === REQUESTS_CHANGED) void view.refresh(); });
  setInterval(() => view.tick(), 1000);
}
