import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { aisHome } from "../shared/ais-home.ts";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * The gateway's proof of ownership. `ais gateway serve` writes this file after every keep-alive pass: the logins it holds
 * (tool/identity, no secrets) and the time of its last successful refresh of each. Other processes treat a codex, grok or
 * kimi login as gateway-owned only while the heartbeat is fresh and names it; a stale or missing file means they refresh as before.
 */
export interface GatewayHeartbeat {
  version: 1;
  /** When the last keep-alive pass finished (ISO). */
  passAt: string;
  /** "tool/identity" to the ISO time the gateway last refreshed it successfully (absent when it has not yet). */
  held: Record<string, { lastSuccessAt?: string }>;
}

export const HEARTBEAT_FRESH_MS = 30 * 60_000;

/** AIS_GATEWAY_HEARTBEAT overrides the location (tests, odd layouts). */
export const heartbeatPath = (): string => process.env.AIS_GATEWAY_HEARTBEAT ?? join(aisHome(), "gateway-heartbeat.json");

export async function writeHeartbeat(hb: GatewayHeartbeat, path: string = heartbeatPath()): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(hb)}\n`);
}

/** The heartbeat, or undefined when missing or malformed. */
export async function readHeartbeat(path: string = heartbeatPath()): Promise<GatewayHeartbeat | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<GatewayHeartbeat>;
    if (parsed.version !== 1 || typeof parsed.passAt !== "string" || !Number.isFinite(Date.parse(parsed.passAt))) return undefined;
    if (typeof parsed.held !== "object" || parsed.held === null || Array.isArray(parsed.held)) return undefined;
    return parsed as GatewayHeartbeat;
  } catch {
    return undefined;
  }
}

/** True when a fresh heartbeat names the login. */
export async function heartbeatHolds(tool: string, identityName: string, nowMs: number = Date.now(), path?: string): Promise<boolean> {
  const hb = await readHeartbeat(path);
  if (!hb) return false;
  const age = nowMs - Date.parse(hb.passAt);
  return age <= HEARTBEAT_FRESH_MS && age >= -60_000 && Object.hasOwn(hb.held, `${tool}/${identityName}`);
}
