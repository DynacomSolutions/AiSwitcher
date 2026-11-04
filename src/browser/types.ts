// Shared with the Chrome extension: keep free of Node and Bun imports.
export type BrowserTarget = { kind: "identity"; identity: string } | { kind: "pool"; pool: string };

export interface BrowserBinding {
  name: string;
  target: BrowserTarget;
  profileLabel: string;
  state: "active" | "revoked";
  createdAt: string;
  lastSeenAt?: string;
}

export interface BrowserPairing {
  code: string;
  profileLabel: string;
  createdAt: string;
  expiresAt: string;
  approvedBinding?: string;
  tokenDelivered: boolean;
}

export interface AgentTokenRecord {
  identity: string;
  prefix: string;
  hash: string;
  createdAt: string;
  revokedAt?: string;
}
