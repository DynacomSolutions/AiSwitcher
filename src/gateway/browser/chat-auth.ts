/** Who a chat token stands for. The broker builds it from the live chat record. */
export interface ChatPrincipal {
  chatId: string;
  /** The one browser binding that created the chat. */
  binding: string;
  identity: string;
  label: string;
  color: string;
  /** Tab ids the chat may drive. */
  linked: ReadonlySet<number>;
}

export interface ChatAuth {
  /** The principal for a chat token. Undefined when the token is forged or expired, or when the chat is closed. */
  principal(token: string): Promise<ChatPrincipal | undefined>;
}
