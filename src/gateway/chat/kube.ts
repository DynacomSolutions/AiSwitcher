// Kubernetes types and the AgentSession builder for chat pods. No network code lives here.
import type { ChatProvider } from "../../browser/chat-protocol.ts";

export interface PodStream {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** Gets redacted stderr, one line at a time, each line capped at 4 KiB. */
  onStderr(cb: (chunk: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}
export interface PodSpecInput { chatId: string; generation: number; provider: ChatProvider; identity: string }
export interface PodHandle { name: string; session: string; cwd: string; stream: PodStream }
/** Fixed copy by reason. It never holds the controller's raw message. */
export type PodPhaseNotice = { reason: string; text: string };

/** The `agent-runtime-config` ConfigMap, key `config.json`. The broker reads only the fields it names. */
export interface AgentRuntimeProviderConfig { identities?: string[]; app?: string; identityApps?: Record<string, string> }
export interface AgentRuntimeConfig { providers?: Partial<Record<ChatProvider, AgentRuntimeProviderConfig>>; [key: string]: unknown }

export interface PodTransport {
  /** Create, wait for Running, attach, then send heartbeats until the stream ends. */
  start(input: PodSpecInput, signal: AbortSignal, onPhase: (n: PodPhaseNotice) => void): Promise<PodHandle>;
  /** Delete the sessions labelled with this chat id. */
  stop(chatId: string): Promise<void>;
  /** Delete one named session and close its stream here. Used when the lease of a chat is lost, so no other replica's session is hit. */
  stopSession(session: string): Promise<void>;
  /** Read the ConfigMap. */
  catalog(): Promise<AgentRuntimeConfig>;
}

export interface KubeConfigEnv { group: string; namespace: string; node: string; configMap: string;
  /** Value of `spec.class` on every chat AgentSession. Read from `AIS_GATEWAY_CHAT_CLASS`. */
  class: string }

export const sessionName = (chatId: string, generation: number): string => `chat-${chatId.replace(/-/g, "").slice(0, 8)}-${generation}`;
export const ACP_ARGS: Record<ChatProvider, string[]> = { claude: ["claude-code-acp"], codex: ["codex-acp"], kimi: [], grok: [], zai: [], opencode: [] };

/** `startId` is a nonce for one start call. It lets cleanup tell its own session from another start of the same chat. */
export function buildChatSession(i: PodSpecInput, env: KubeConfigEnv, nowS: number, startId?: string): object {
  const g = env.group;
  return {
    apiVersion: `${g}/v1alpha1`,
    kind: "AgentSession",
    metadata: {
      name: sessionName(i.chatId, i.generation),
      namespace: env.namespace,
      labels: { [`${g}/created-by`]: "ais-gateway", [`${g}/chat-id`]: i.chatId },
      annotations: { [`${g}/client-seen`]: String(nowS), ...(startId ? { [`${g}/start-id`]: startId } : {}) },
    },
    spec: { workspace: "chat", provider: i.provider, identity: i.identity, node: env.node, class: env.class, args: ACP_ARGS[i.provider] },
  };
}

export interface KubeSession {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
  status?: { phase?: string; reason?: string; message?: string; pod?: string; worktreePath?: string };
}

/** One attach WebSocket. Frames are raw bytes: the first byte is the channel. */
export interface KubeSocket {
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export interface KubeApi {
  createSession(obj: object, signal?: AbortSignal): Promise<KubeSession>;
  getSession(name: string, signal?: AbortSignal): Promise<KubeSession | undefined>;
  listSessions(labelSelector: string): Promise<KubeSession[]>;
  /** Streams changes of one session. A `undefined` session means it was deleted. `onEnd` runs once when the stream stops. */
  watchSession(name: string, onEvent: (s: KubeSession | undefined) => void, onEnd: (reason: string) => void): { close(): void };
  annotate(name: string, notes: Record<string, string>): Promise<void>;
  /** A session that is already gone is not an error. */
  deleteSession(name: string): Promise<void>;
  getConfigMap(name: string): Promise<Record<string, string>>;
  /** Resolves when the socket is open. Rejects on a failed upgrade or on abort. */
  openAttach(pod: string, signal: AbortSignal): Promise<KubeSocket>;
}
