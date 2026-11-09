import { access, constants, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AliAuthRefreshError, refreshAliAuthSession } from "../identities/auth-session.ts";
import { getAuthBrowserNamespace } from "../identities/auth-browser.ts";
import { listAliAccounts } from "../identities/gateway-managed.ts";
import { expandPath } from "../identities/match.ts";
import type { Identity } from "../identities/types.ts";
import type { Alerter } from "./alerts.ts";

export { listAliAccounts };

/** Gap between two renewals of one login (the retired host timer ran every ten minutes). */
export const ALI_RENEW_EVERY_MS = 10 * 60_000;
/** A renewal is due once this much of the gap has passed: the timer tick, the OAuth pass before it and timer jitter must not push a login to every other tick. */
export const ALI_RENEW_SLACK_MS = 60_000;
/** This many skipped renewals in a row because a person is on the sign-in page raises the alert (the page may simply have been abandoned). */
const LOGIN_PAGE_ALERT_AFTER = 3;

/** The exact thing a person can do, worded for a gateway that runs in a pod (no host-only commands, no noVNC hints for pod tools). */
function gatewayHint(code: AliAuthRefreshError["code"], identity: string): string {
  switch (code) {
    case "browser-unreachable":
      return "the gateway cannot reach the chrome-auth browser: check that deployment and the gateway pod's kubectl, port-forward permission and AIS_K8S_API_SERVER (docs/agents/gateway.md, ali login)";
    case "not-signed-in":
    case "login-in-progress":
      return `sign in again: on a host that can open the auth browser run 'ais auth login ${identity} --tool=ali' and finish sign-in over noVNC; the gateway renews it from then on`;
    case "harvest-failed":
      return "retry; if it persists restart the chrome-auth deployment and sign in again";
    default:
      return "see the gateway log";
  }
}

/**
 * The gateway owns the ali login. Alibaba's Token plan key is static, but the console session behind its usage figures is a
 * browser login that expires unless it is visited regularly: this renews it for every live ali identity, as the host's
 * `ais-ali-auth-refresh-<identity>` systemd timer did. Each attempt is counted (`ais_gateway_keepalive_total{provider="ali"}`),
 * and a failure raises one owner alert (with the exact fix) until the next success. Never throws.
 * `signal` ends the pass at once on shutdown: the renewal in flight is abandoned (it holds only the browser lock, which it frees itself).
 */
export async function aliSessionOnce(deps: {
  accounts?: () => Promise<Identity[]>;
  refresh?: (identity: Identity, signal?: AbortSignal) => Promise<string>;
  metrics: { keepAlive(provider: string, outcome: string): void };
  alerter: Alerter;
  /** "ali/<name>" to the ISO time the last successful renewal STARTED; a login renewed within the interval is left alone. */
  lastSuccess?: Map<string, string>;
  now?: () => Date;
  everyMs?: number;
  signal?: AbortSignal;
  /** Consecutive "a person is on the sign-in page" skips per login (kept between passes). */
  loginPageSkips?: Map<string, number>;
}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const due = (deps.everyMs ?? ALI_RENEW_EVERY_MS) - ALI_RENEW_SLACK_MS;
  const refresh = deps.refresh ?? refreshAliAuthSession;
  const lastSuccess = deps.lastSuccess ?? new Map<string, string>();
  const skips = deps.loginPageSkips ?? new Map<string, number>();
  const aborted = new Promise<"aborted">((resolve) => {
    if (deps.signal?.aborted) resolve("aborted");
    else deps.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  for (const account of await (deps.accounts ?? listAliAccounts)().catch(() => [] as Identity[])) {
    if (deps.signal?.aborted) return;
    const key = `ali/${account.name}`;
    const last = lastSuccess.get(key);
    if (last !== undefined && now().getTime() - Date.parse(last) < due) {
      deps.metrics.keepAlive("ali", "skipped-fresh");
      continue;
    }
    // Stamped from when the attempt began: the renewal itself takes seconds, and counting from its end drifts a 10-minute cadence to 20.
    const startedAt = now().toISOString();
    try {
      const done = await Promise.race([refresh(account, deps.signal), aborted]);
      if (done === "aborted") {
        deps.metrics.keepAlive("ali", "aborted");
        return;
      }
      lastSuccess.set(key, startedAt);
      skips.delete(key);
      deps.metrics.keepAlive("ali", "refreshed");
      deps.alerter.recover("refresh-failed", key);
    } catch (err) {
      const code = err instanceof AliAuthRefreshError ? err.code : "other";
      if (code === "busy") {
        deps.metrics.keepAlive("ali", "busy"); // another renewal holds the shared tab; the next tick retries
        continue;
      }
      if (code === "login-in-progress") {
        const n = (skips.get(key) ?? 0) + 1;
        skips.set(key, n);
        deps.metrics.keepAlive("ali", "login-in-progress");
        if (n < LOGIN_PAGE_ALERT_AFTER) continue;
      }
      deps.metrics.keepAlive("ali", "failed");
      const why = err instanceof Error ? err.message : "unknown error";
      deps.alerter.raise("refresh-failed", key, `renewal of the ali login "${account.name}" failed (${why}); ${gatewayHint(code, account.name)}`);
    }
  }
}

export interface AliSetupDeps {
  which?: (cmd: string) => string | null;
  env?: Record<string, string | undefined>;
  writable?: (dir: string) => Promise<boolean>;
  /** Runs `kubectl auth can-i create pods/portforward`; true when it answers yes. */
  canPortForward?: () => Promise<boolean>;
  accounts?: () => Promise<Identity[]>;
}

const defaultWritable = async (dir: string): Promise<boolean> => {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

async function defaultCanPortForward(env: Record<string, string | undefined>): Promise<boolean> {
  const args = ["kubectl"];
  if (env.AIS_K8S_API_SERVER) args.push("--server", env.AIS_K8S_API_SERVER);
  args.push("-n", getAuthBrowserNamespace(), "auth", "can-i", "create", "pods/portforward");
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return (await proc.exited) === 0 && out === "yes";
  } catch {
    return false;
  }
}

/** What the gateway needs to renew ali sessions but does not have. Empty when there is no ali login or all is in place. */
export async function aliSetupProblems(deps: AliSetupDeps = {}): Promise<string[]> {
  const accounts = await (deps.accounts ?? listAliAccounts)().catch(() => [] as Identity[]);
  if (accounts.length === 0) return [];
  const env = deps.env ?? process.env;
  const problems: string[] = [];
  const writable = deps.writable ?? defaultWritable;
  if (!(deps.which ?? Bun.which)("kubectl")) problems.push("kubectl is not on the gateway's PATH");
  else {
    // Inside a pod the kubeconfig's loopback API address is unreachable: the in-cluster address must be given.
    if (!(deps.which ?? Bun.which)("systemd-run") && !env.AIS_K8S_API_SERVER) problems.push("AIS_K8S_API_SERVER is not set (no in-pod API address for kubectl)");
    if (!(await (deps.canPortForward ?? (() => defaultCanPortForward(env)))())) problems.push(`the gateway may not port-forward to pods in namespace ${getAuthBrowserNamespace()} (needs the pods/portforward permission)`);
  }
  if (!(await writable(join(homedir(), ".ais", "auth-browser")))) problems.push("the auth-browser state directory (~/.ais/auth-browser) is not writable");
  for (const a of accounts) if (!(await writable(expandPath(a.configDir)))) problems.push(`the ali identity directory for "${a.name}" is not writable (the session cookie file is written there)`);
  return problems;
}

/** Startup self-test: one owner alert listing what is missing, cleared when a later check finds nothing. */
export async function aliSetupSelfTest(alerter: Alerter, deps: AliSetupDeps = {}): Promise<string[]> {
  const problems = await aliSetupProblems(deps);
  if (problems.length > 0) alerter.raise("ali-setup-missing", "ali", `the gateway cannot renew ali logins: ${problems.join("; ")} (docs/agents/gateway.md, ali login)`);
  else alerter.recover("ali-setup-missing", "ali");
  return problems;
}
