// One-time approval prompt: a Chrome notification with two buttons. The answer settles one waiting call.
import type { ChromeApi } from "./chrome-api.ts";

export type PromptAnswer = "approve" | "deny" | "closed" | "timeout" | "aborted";

export const APPROVE_LABEL = "Approve";
export const DENY_LABEL = "Deny";

export class GroupPrompt {
  private readonly pending = new Map<string, (answer: PromptAnswer) => void>();

  constructor(private readonly api: ChromeApi, private readonly newId: () => string = () => crypto.randomUUID()) {
    // Registered when the worker starts, so the listeners exist when Chrome wakes it for a click.
    api.notifications.onButtonClicked((id, index) => this.settle(id, index === 0 ? "approve" : "deny"));
    api.notifications.onClosed(id => this.settle(id, "closed"));
  }

  /** Shows the prompt and waits for one answer. The notification is always cleared when the wait ends. */
  async ask(opts: { title: string; message: string }, signal: AbortSignal, timeoutMs: number): Promise<PromptAnswer> {
    if (signal.aborted) return "aborted";
    const id = this.newId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answer = new Promise<PromptAnswer>(resolve => {
      this.pending.set(id, resolve);
      timer = setTimeout(() => this.settle(id, "timeout"), timeoutMs);
      onAbort = () => this.settle(id, "aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await this.api.notifications.create(id, { ...opts, buttons: [APPROVE_LABEL, DENY_LABEL] });
    } catch {
      this.pending.delete(id);
      clearTimeout(timer);
      return "deny"; // no notification could be shown: nobody can approve
    }
    try {
      return await answer;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
      await this.api.notifications.clear(id).catch(() => {});
    }
  }

  private settle(id: string, answer: PromptAnswer): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(answer);
  }
}
