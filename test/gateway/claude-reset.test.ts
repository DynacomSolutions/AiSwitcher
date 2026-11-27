import { describe, expect, test } from "bun:test";
import { CLAUDE_RESETS_USER_AGENT } from "../../src/identities/claude-usage-api.ts";
import {
  CLAUDE_RESET_INVENTORY_URL, claudeCreditInventory, consumeClaudeResetForIdentity, fetchGatewayClaudeState, type ClaudeResetSelection,
} from "../../src/gateway/claude-reset.ts";

const NOW = Date.parse("2026-11-27T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const FULL = "full-reset-SYNTHETIC_FIXTURE";
const FABLE = "launch-fable-SYNTHETIC_FIXTURE";
const ENDS = iso(NOW + 3_600_000);
const WEEK_RESET = iso(NOW + 86_400_000);
const credential = { identity: "fixture-claude", accessToken: "tok_SYNTHETIC_FIXTURE" };

const cedar = (over: Record<string, unknown> = {}) => ({
  eligible: true,
  grants: [
    { id: FULL, label: "One full limit reset", resets_left: 1, usable_now: true, paused: false, ends_at: ENDS },
    { id: FABLE, label: "One Fable reset", resets_left: 1, usable_now: true, paused: false, ends_at: ENDS },
  ],
  ...over,
});
const usageBody = (weekly = 100, extra: Record<string, unknown> = {}) => ({
  five_hour: { utilization: 40, resets_at: iso(NOW + 3_600_000) },
  seven_day: { utilization: weekly, resets_at: WEEK_RESET },
  cedar_ember: cedar(),
  ...extra,
});

interface Call { url: string; method: string; headers: Headers; body?: Record<string, unknown> }

function fakeFetch(answers: { usage?: () => Response; profile?: () => Response; post?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const doFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) };
    calls.push(call);
    if (url === CLAUDE_RESET_INVENTORY_URL) return answers.usage?.() ?? Response.json(usageBody());
    if (url.endsWith("/api/oauth/profile")) return answers.profile?.() ?? Response.json({ organization: { uuid: "org-SYNTHETIC" } });
    if (url.endsWith("/reset_rate_limits")) return answers.post?.() ?? Response.json({ result: "reset", grant_id: FULL, cleared: ["seven_day"] });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { doFetch, calls };
}

function selection(over: Partial<ClaudeResetSelection> = {}): ClaudeResetSelection & { posts: number; armed: number } {
  const state = { posts: 0, armed: 0 };
  return Object.assign(state, {
    id: FULL, endsAt: ENDS, signal: AbortSignal.timeout(5_000), now: () => NOW,
    stillCurrent: () => true, stillEligible: async () => true,
    beforePost: async () => { state.armed++; },
    onPost: () => { state.posts++; },
    ...over,
  });
}

describe("Claude reset credits", () => {
  test("only a full, usable, unpaused grant with an absolute expiry counts", () => {
    const grants = (list: object[], extra: object = {}) => claudeCreditInventory({ availableCount: 9, grants: list as never, ...extra }, NOW, NOW);
    const full = { id: FULL, kind: "full", resetsLeft: 1, usableNow: true, paused: false, endsAt: ENDS };
    expect(grants([full])?.creditExpiries).toEqual([{ id: FULL, endsAt: ENDS }]);
    expect(grants([{ ...full, kind: "fable" }])?.availableCount).toBe(0);
    expect(grants([{ ...full, kind: "other" }])?.availableCount).toBe(0);
    expect(grants([{ ...full, usableNow: false }])?.availableCount).toBe(0);
    expect(grants([{ ...full, paused: true }])?.availableCount).toBe(0);
    expect(grants([{ ...full, resetsLeft: 0 }])?.availableCount).toBe(0);
    expect(grants([{ ...full, endsAt: undefined }])?.availableCount).toBe(0);
    expect(grants([{ ...full, endsAt: iso(NOW - 1) }])?.availableCount).toBe(0);
    expect(grants([full], { stale: true })?.availableCount).toBe(0);
    expect(grants([full], { cooldownUntil: iso(NOW + 1_000) })?.availableCount).toBe(0);
    expect(claudeCreditInventory(undefined, NOW, NOW)).toBeUndefined();
  });

  test("one read gives the usage windows and the grants, with the claude-cli User-Agent", async () => {
    const { doFetch, calls } = fakeFetch();
    const read = await fetchGatewayClaudeState(credential, doFetch, () => NOW, AbortSignal.timeout(5_000));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", method: "GET" });
    expect(calls[0]!.headers.get("user-agent")).toBe(CLAUDE_RESETS_USER_AGENT);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok_SYNTHETIC_FIXTURE");
    expect(read.usage).toMatchObject({ status: "live", capturedAt: iso(NOW) });
    expect(read.usage.windows?.map((w) => [w.label, w.utilization])).toEqual([["five-hour", 40], ["seven-day", 100]]);
    expect(read.credits?.creditExpiries).toEqual([{ id: FULL, label: "One full limit reset", endsAt: ENDS }]);
  });

  test("a refused or broken read is unavailable and carries no credits", async () => {
    for (const answer of [() => new Response("{}", { status: 429 }), () => new Response("{}", { status: 403 })]) {
      const read = await fetchGatewayClaudeState(credential, fakeFetch({ usage: answer }).doFetch, () => NOW, AbortSignal.timeout(5_000));
      expect(read.usage.status).toBe("unavailable");
      expect(read.credits).toBeUndefined();
    }
    const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect((await fetchGatewayClaudeState(credential, down, () => NOW, AbortSignal.timeout(5_000))).usage.status).toBe("unavailable");
  });
});

describe("Claude reset spend", () => {
  test("reads the grant again, then sends one POST with the named grant", async () => {
    const { doFetch, calls } = fakeFetch();
    const chosen = selection();
    const spent = await consumeClaudeResetForIdentity("fixture-claude", credential, doFetch, chosen, () => "request-SYNTHETIC");
    expect(spent).toEqual({ identity: "fixture-claude", result: "reset", creditId: FULL });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/oauth/usage", "GET /api/oauth/profile", "POST /api/organizations/org-SYNTHETIC/reset_rate_limits",
    ]);
    expect(calls[2]!.body).toEqual({ program: "cedar_ember", grant_id: FULL, request_id: "request-SYNTHETIC" });
    expect(calls[2]!.headers.get("user-agent")).toBe(CLAUDE_RESETS_USER_AGENT);
    expect(chosen.armed).toBe(1);
    expect(chosen.posts).toBe(1);
  });

  test("sends no POST when the live read no longer lists the grant, its expiry changed, or the week is not full", async () => {
    const cases: Array<[string, () => Response, string]> = [
      ["grant gone", () => Response.json(usageBody(100, { cedar_ember: cedar({ grants: [] }) })), "no_credit"],
      ["grant used", () => Response.json(usageBody(100, { cedar_ember: cedar({ grants: [{ id: FULL, resets_left: 0, usable_now: false, ends_at: ENDS }] }) })), "no_credit"],
      ["expiry moved", () => Response.json(usageBody(100, { cedar_ember: cedar({ grants: [{ id: FULL, resets_left: 1, usable_now: true, ends_at: iso(NOW + 7_200_000) }] }) })), "no_credit"],
      ["week not full", () => Response.json(usageBody(60)), "nothing_to_reset"],
      ["read failed", () => new Response("{}", { status: 429 }), "no_credit"],
    ];
    for (const [name, usage, result] of cases) {
      const { doFetch, calls } = fakeFetch({ usage });
      const chosen = selection();
      expect((await consumeClaudeResetForIdentity("fixture-claude", credential, doFetch, chosen)).result, name).toBe(result as never);
      expect(calls.filter((c) => c.method === "POST"), name).toHaveLength(0);
      expect(chosen.posts, name).toBe(0);
    }
  });

  test("sends no POST when the claim is no longer current or eligible, or the account fence refuses", async () => {
    for (const over of [{ stillEligible: async () => false }, { stillCurrent: () => false }]) {
      const { doFetch, calls } = fakeFetch();
      const chosen = selection(over);
      expect((await consumeClaudeResetForIdentity("fixture-claude", credential, doFetch, chosen)).result).toBe("no_credit");
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    }
    const { doFetch, calls } = fakeFetch();
    const fenced = selection({ beforePost: async () => { throw Object.assign(new Error("pending"), { status: 409, postAttempted: false }); } });
    await expect(consumeClaudeResetForIdentity("fixture-claude", credential, doFetch, fenced)).rejects.toMatchObject({ postAttempted: false });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await expect(consumeClaudeResetForIdentity("someone-else", credential, doFetch, selection())).rejects.toMatchObject({ status: 409 });
  });

  test("a profile failure sends no POST", async () => {
    const { doFetch, calls } = fakeFetch({ profile: () => new Response("{}", { status: 500 }) });
    await expect(consumeClaudeResetForIdentity("fixture-claude", credential, doFetch, selection())).rejects.toMatchObject({ postAttempted: false });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("an unclear or lost answer is an unknown outcome, and a refusal is a provider refusal", async () => {
    const unclear = fakeFetch({ post: () => Response.json({ result: "queued" }) });
    await expect(consumeClaudeResetForIdentity("fixture-claude", credential, unclear.doFetch, selection())).rejects.toMatchObject({
      status: 502, creditedId: FULL,
    });
    const lost = fakeFetch({ post: () => { throw new Error("socket closed"); } });
    const posted = selection();
    await expect(consumeClaudeResetForIdentity("fixture-claude", credential, lost.doFetch, posted)).rejects.toMatchObject({ status: 502 });
    expect(posted.posts).toBe(1);
    const refused = fakeFetch({ post: () => new Response("{}", { status: 403 }) });
    await expect(consumeClaudeResetForIdentity("fixture-claude", credential, refused.doFetch, selection())).rejects.toMatchObject({ status: 403 });
    for (const fake of [unclear, lost, refused]) expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("maps the provider results", async () => {
    for (const [result, expected] of [["reset", "reset"], ["nothing_to_reset", "nothing_to_reset"], ["no_credit", "no_credit"], ["already_redeemed", "already_redeemed"]] as const) {
      const { doFetch } = fakeFetch({ post: () => Response.json({ result }) });
      expect((await consumeClaudeResetForIdentity("fixture-claude", credential, doFetch, selection())).result).toBe(expected);
    }
  });
});
