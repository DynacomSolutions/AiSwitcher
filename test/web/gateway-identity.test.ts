import { describe, expect, test } from "bun:test";
import { addIdentityBody, addIdentityProblem, canAddGatewayIdentity } from "../../apps/web/src/lib/gateway-identity.ts";

const form = (over: Partial<Parameters<typeof addIdentityBody>[0]> = {}) => ({ name: "identity-a", label: "", description: "", pool: "", ...over });

describe("add identity form", () => {
  test("only claude and codex can be added through the gateway", () => {
    expect(canAddGatewayIdentity("claude")).toBe(true);
    expect(canAddGatewayIdentity("codex")).toBe(true);
    expect(canAddGatewayIdentity("grok")).toBe(false);
  });

  test("problems: empty, bad slug, taken name", () => {
    expect(addIdentityProblem(form({ name: " " }), [])).toBe("Enter a name.");
    for (const name of ["Bad", "a b", "-a", "a-", "a--b", "a/b"]) expect(addIdentityProblem(form({ name }), [])).toContain("lowercase");
    expect(addIdentityProblem(form({ name: "taken" }), ["taken"])).toContain("already in use");
    expect(addIdentityProblem(form(), ["other"])).toBeUndefined();
  });

  test("body: trimmed, label falls back to the name, empty optionals are left out", () => {
    expect(addIdentityBody(form({ name: " identity-a " }))).toEqual({ name: "identity-a", label: "identity-a" });
    expect(addIdentityBody(form({ label: " L ", description: " d ", pool: "pool-a" }))).toEqual({ name: "identity-a", label: "L", description: "d", pool: "pool-a" });
  });
});
