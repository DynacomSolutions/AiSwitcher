import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { expandPath } from "../../identities/match.ts";
import { fetchWithRetry } from "./http.ts";
import type { LimitCategory, LimitWindow, FetchedLimitResult } from "./types.ts";

/**
 * Alibaba Cloud Model Studio's Token plan has NO quota/usage endpoint that
 * accepts its `sk-sp-...` inference key — confirmed live 2026-08-07 by
 * probing the inference host directly (only `/v1/messages` exists; every
 * plausible usage/quota path 404s "Not support") and independently via
 * CodexBar's own implementation (steipete/CodexBar, the most complete
 * open-source one), which states this outright: "API-key auth ... not
 * supported" for this plan. The ONLY known working route is the Alibaba
 * OneConsole browser gateway, authenticated by the user's console-session
 * cookies — the exact request construction below mirrors CodexBar's
 * `AlibabaTokenPlanUsageFetcher` one-for-one (URL, headers, form body, and
 * the `cornerstoneParam` client-context object, which carries NO secrets —
 * its `switchAgent` field is deliberately omitted, same as CodexBar, because
 * a captured agent ID binds the request to one account's workspace and makes
 * every other account fail with `BailianGateway.Workspace.NotAuthorised`).
 *
 * The cookie is read from `<configDir>/console-cookie.txt`. It must be
 * refreshed by an authentication flow that can actually present Alibaba's
 * interactive login; a headless SSH-hosted browser cannot provide that.
 */
const GATEWAY_URL =
  "https://bailian-singapore-cs.alibabacloud.com/data/api.json" +
  "?action=IntlBroadScopeAspnGateway&product=sfm_bailian" +
  "&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage&_v=undefined";
const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const DASHBOARD_URL =
  "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal";
const DASHBOARD_ORIGIN = "https://modelstudio.console.alibabacloud.com";
const COOKIE_FILE = "console-cookie.txt";

/** The gateway wraps its real payload three levels deep: the outer envelope's
 * `data.DataV2.data.data` carries the rolling-window usage. Confirmed LIVE
 * 2026-08-07 against a real Token plan account on this machine (CodexBar's
 * own parser walks the same nesting generically via a "find the object
 * containing per5HourPercentage" search, which is why its fixture didn't make
 * the exact depth obvious): `per5HourPercentage`/`per1WeekPercentage` are 0-1
 * FRACTIONS, not 0-100 points, and reset times are epoch milliseconds. Also
 * confirmed live: `per5HourPercentage`/`per5HourResetTime` are OMITTED
 * entirely (not null) when there's no active 5h window — the first real
 * response carried ONLY the week entry, so the session window simply doesn't
 * render rather than showing 0. */
export interface AliUsageWire {
  per5HourPercentage?: number;
  per5HourResetTime?: number;
  per1WeekPercentage?: number;
  per1WeekResetTime?: number;
}

export interface AliGatewayResponseWire {
  code?: string;
  successResponse?: boolean;
  data?: {
    success?: boolean;
    errorCode?: string;
    errorMsg?: string;
    DataV2?: { success?: boolean; data?: { success?: boolean; data?: AliUsageWire } };
  };
}

async function readConsoleCookie(configDir: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(join(expandPath(configDir), COOKIE_FILE)).text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function extractCsrf(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "login_aliyunid_csrf" || name === "csrf") return part.slice(eq + 1).trim();
  }
  return undefined;
}

function formatResetsAt(ms: number | undefined): string | undefined {
  if (ms === undefined || Number.isNaN(new Date(ms).getTime())) return undefined;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Pure mapping from the FULL gateway envelope to display windows, exported
 * so tests can exercise it without any network or cookie. Follows the same
 * nesting CodexBar's own parser walks: the outer envelope's
 * `data.DataV2.data.data` carries the rolling-window usage object. */
export function windowsFromAliGatewayResponse(resp: AliGatewayResponseWire): LimitWindow[] {
  const usage = resp.data?.DataV2?.data?.data;
  return usage ? windowsFromAliUsage(usage) : [];
}

/** Pure mapping from the wire shape to display windows, exported so tests can
 * exercise it without any network or cookie. Fractions become percentage
 * points, clamped to 0-100. */
export function windowsFromAliUsage(wire: AliUsageWire): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const entries: Array<{ fraction: number | undefined; reset: number | undefined; label: string; category: LimitCategory }> = [
    { fraction: wire.per5HourPercentage, reset: wire.per5HourResetTime, label: "session (5h)", category: "session" },
    { fraction: wire.per1WeekPercentage, reset: wire.per1WeekResetTime, label: "week", category: "week" },
  ];
  for (const entry of entries) {
    if (typeof entry.fraction !== "number") continue;
    windows.push({
      label: entry.label,
      category: entry.category,
      usedPercent: Math.min(100, Math.max(0, entry.fraction * 100)),
      resetsAt: formatResetsAt(entry.reset),
    });
  }
  return windows;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unavailable(base: Pick<FetchedLimitResult, "toolName" | "identity">, error: string): FetchedLimitResult {
  return { ...base, windows: [], status: "unavailable", error };
}

type GatewayResult =
  | { kind: "payload"; payload: AliGatewayResponseWire }
  | { kind: "expired" }
  | { kind: "error"; message: string };

async function requestAliGateway(cookie: string): Promise<GatewayResult> {
  const cornerstoneParam = {
    feTraceId: crypto.randomUUID().toLowerCase(),
    feURL: DASHBOARD_URL,
    protocol: "V2",
    console: "ONE_CONSOLE",
    productCode: "p_efm",
    switchUserType: 3,
    domain: "modelstudio.console.alibabacloud.com",
    consoleSite: "MODELSTUDIO_ALBABACLOUD",
    userNickName: "",
    userPrincipalName: "",
    xsp_lang: "en-US",
  };
  const params = JSON.stringify({ Api: USAGE_API, V: "1.0", Data: { cornerstoneParam } });
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: "IntlBroadScopeAspnGateway",
    region: "ap-southeast-1",
    language: "en-US",
    params,
  }).toString();

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    Cookie: cookie,
    "X-Requested-With": "XMLHttpRequest",
    Origin: DASHBOARD_ORIGIN,
    Referer: DASHBOARD_URL,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  };
  const csrf = extractCsrf(cookie);
  if (csrf) {
    headers["x-xsrf-token"] = csrf;
    headers["x-csrf-token"] = csrf;
  }

  let response: Response;
  try {
    // The gateway query is a read — safe to retry on transport failures
    // (the machine's connectivity blips under report load; observed live
    // 2026-09-03). HTTP error statuses are returned as-is.
    response = await fetchWithRetry(GATEWAY_URL, {
      method: "POST",
      headers,
      body,
    });
  } catch (err) {
    return { kind: "error", message: `quota fetch failed: ${errorMessage(err)}` };
  }
  if (!response.ok) return { kind: "error", message: `quota fetch failed (HTTP ${response.status})` };

  const text = await response.text();
  if (text.includes("<html") && /sign.?in|login/i.test(text)) return { kind: "expired" };

  let payload: AliGatewayResponseWire;
  try {
    payload = JSON.parse(text) as AliGatewayResponseWire;
  } catch (err) {
    return { kind: "error", message: `could not parse quota response: ${errorMessage(err)}` };
  }
  const code = payload.data?.errorCode ?? "";
  if (payload.data?.success === false && (code.includes("NotLogined") || code.includes("Login"))) return { kind: "expired" };
  return { kind: "payload", payload };
}

/**
 * Fetches live rolling-window quota for one ali identity via the Alibaba
 * OneConsole gateway, authenticated with the console-session cookie from
 * `<configDir>/console-cookie.txt` (see the module doc above for why no
 * API-key path exists and where this protocol came from).
 */
export async function fetchAliLimits(identity: Identity): Promise<FetchedLimitResult> {
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "ali", identity };

  const cookie = await readConsoleCookie(identity.configDir);
  if (!cookie) {
    return unavailable(
      base,
      `not authenticated — put a valid Alibaba Cloud console Cookie header in ${join(expandPath(identity.configDir), COOKIE_FILE)}`,
    );
  }

  const gateway = await requestAliGateway(cookie);
  if (gateway.kind === "expired") {
    return unavailable(base, "console session expired — replace console-cookie.txt with a fresh Alibaba Cloud console Cookie header");
  }
  if (gateway.kind === "error") return unavailable(base, gateway.message);

  const payload = gateway.payload;
  if (payload.data?.success === false) return unavailable(base, payload.data.errorMsg ?? "Alibaba reported the quota request failed");

  const usage = payload.data?.DataV2?.data?.data;
  const windows = usage ? windowsFromAliUsage(usage) : [];
  if (windows.length === 0) {
    return unavailable(base, "ali reported no quota windows");
  }
  return { ...base, windows, status: "live", capturedAt: new Date().toISOString() };
}
