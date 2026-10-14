import { claudeAdapter } from "./claude-adapter.ts";
import { codexAdapter } from "./codex-adapter.ts";
import type { PoolAdapter } from "./adapter.ts";
import type { ToolConfig } from "../types.ts";

const adapters = new Map<string, PoolAdapter<any>>();

export function registerAdapter(adapter: PoolAdapter<any>): void {
  adapters.set(adapter.tool, adapter);
}

export function adapterFor(tool: ToolConfig["toolName"]): PoolAdapter<any> | undefined {
  return adapters.get(tool);
}

export function allAdapters(): PoolAdapter<any>[] {
  return [...adapters.values()];
}

registerAdapter(claudeAdapter);
registerAdapter(codexAdapter);
