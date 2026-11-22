/** Tabs granted to each chat. Several chats may hold the same tab, so a grant belongs to the chat and not to the tab. */
export class ChatGrants {
  private readonly byChat = new Map<string, ReadonlySet<number>>();

  set(chatId: string, tabIds: readonly number[]): void {
    this.byChat.set(chatId, new Set(tabIds));
  }

  get(chatId: string): ReadonlySet<number> | undefined {
    return this.byChat.get(chatId);
  }

  allows(chatId: string, tabId: number): boolean {
    return this.byChat.get(chatId)?.has(tabId) ?? false;
  }

  delete(chatId: string): void {
    this.byChat.delete(chatId);
  }
}
