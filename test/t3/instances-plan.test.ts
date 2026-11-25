import { describe, expect, test } from "bun:test";
import { instanceIdsForApp, planT3Instances, isManagedInstanceId, type GatewayApp } from "../../src/t3/instances/plan.ts";

const app = (name: string, provider: string, target: GatewayApp["target"], state = "active"): GatewayApp => ({ name, provider, target, state });
const pool = { kind: "pool" } as const;
const pin = (identity: string) => ({ kind: "pin", identity }) as const;

const POOL_CLAUDE = ["claude", "pool"].join("-");

describe("planT3Instances", () => {
  test("pool apps give one pool instance per provider, named by pattern", () => {
    const plan = planT3Instances([
      app("agents-claude", "claude", pool),
      app("agents-codex", "codex", pool),
      app("t3-grok-pool", "grok", pool),
      app("t3-kimi-pool", "kimi", pool),
      app("t3-opencode-pool", "opencode", pool),
      app("t3-zai-pool", "zai", pool),
    ]);
    expect(plan.map((p) => p.id).sort()).toEqual([POOL_CLAUDE, "codex-pool", "t3-grok-pool", "t3-grok-pool-acp", "t3-kimi-pool-acp", "t3-opencode-pool", "t3-zai-pool-acp"]);
  });

  test("pins give t3-<provider>-<identity>; ACP drivers add -acp", () => {
    const plan = planT3Instances([
      app("t3-claude-org", "claude", pin("org")),
      app("t3-codex-org", "codex", pin("org")),
      app("t3-kimi-org", "kimi", pin("org")),
      app("t3-zai-org-openai", "zai", pin("org")),
      app("t3-opencode-org", "opencode", pin("org")),
    ]);
    expect(plan.map((p) => [p.id, p.kind]).sort()).toEqual([
      ["t3-claude-org", "claude"],
      ["t3-codex-org", "codex"],
      ["t3-kimi-org-acp", "acp-kimi"],
      ["t3-opencode-org", "opencode"],
      ["t3-zai-org-acp", "acp-zai"],
    ]);
  });

  test("a new provider app appears without a code change", () => {
    const plan = planT3Instances([app("t3-grok-pool", "grok", pool), app("t3-grok-extra", "grok", pin("extra"))]);
    expect(plan.map((p) => p.id).sort()).toEqual(["t3-grok-extra", "t3-grok-extra-acp", "t3-grok-pool", "t3-grok-pool-acp"]);
  });

  test("revoked apps, unrelated apps and unknown providers are skipped", () => {
    const plan = planT3Instances([
      app("t3-claude-gone", "claude", pin("gone"), "revoked"),
      app("service-claude", "claude", pool),
      app("t3-ali-pool", "ali", pool),
      app("agents-claude", "claude", pool),
    ]);
    expect(plan.map((p) => p.id)).toEqual([POOL_CLAUDE]);
  });

  test("two active apps for one instance id keep the app named after the instance", () => {
    const plan = planT3Instances([app("t3-zai-org-openai", "zai", pin("org")), app("t3-zai-org", "zai", pin("org"))]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.app).toBe("t3-zai-org");
  });

  test("the plan holds the app that owns each instance", () => {
    expect(planT3Instances([app("t3-codex-org", "codex", pin("org"))])[0]).toMatchObject({ id: "t3-codex-org", app: "t3-codex-org", provider: "codex" });
  });
});

describe("managed ids", () => {
  test("gateway instance ids are recognised, other ids are not", () => {
    for (const id of [POOL_CLAUDE, "codex-pool", "t3-claude-org", "t3-grok-pool-acp", "t3-kimi-org-acp", "t3-opencode-pool", "t3-zai-org-acp"]) expect(isManagedInstanceId(id)).toBe(true);
    for (const id of ["codex", "claudeAgent", "my-own", "t3-zcode-org-acp", "t3-opencode-org-usage"]) expect(isManagedInstanceId(id)).toBe(false);
  });
  test("instanceIdsForApp lists the ids one app owns", () => {
    expect(instanceIdsForApp(app("t3-grok-org", "grok", pin("org"))).sort()).toEqual(["t3-grok-org", "t3-grok-org-acp"]);
  });
});
