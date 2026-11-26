import { describe, expect, test } from "bun:test";
import { AcpRelay } from "../../src/acp/relay.ts";

// The form ZCode (zcode-acp-server 0.88.1, docs/PROTOCOL.md "elicitation form example") sends for AskUserQuestion. T3 0.1.7
// stored this question as q_0 + q_0_other with no options (measured 25 Nov 2026).
const zcodeForm = (id: number | string = 9) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "elicitation/create",
    params: {
      mode: "form",
      sessionId: "s1",
      message: "Please answer 2 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q_0: { type: "string", title: "Rotate the tokens?", oneOf: [{ const: "Yes", title: "Yes" }, { const: "No", title: "No" }, { const: "__skip__", title: "Skip this question" }] },
          q_0_other: { type: "string", title: "↳    or type a custom value (overrides the selection)" },
          q_1: { type: "string", title: "Which files?", oneOf: [{ const: "auth.test.ts", title: "auth.test.ts" }, { const: "__skip__", title: "Skip this question" }] },
          q_1_other: { type: "string", title: "↳    or type a custom value (overrides the selection)" },
        },
        required: [],
      },
    },
  });

const answer = (id: number | string, content: Record<string, string>) => JSON.stringify({ jsonrpc: "2.0", id, result: { action: "accept", content } });

function relay(questionForms = true) {
  const logs: string[] = [];
  return { r: new AcpRelay({ questionForms, log: (l) => logs.push(l) }), logs };
}

describe("ZCode question forms", () => {
  test("the form reaches the client in the shape T3's generic path shows as option buttons", async () => {
    const { r } = relay();
    const out = await r.fromAgent(zcodeForm());
    expect(out.length).toBe(1);
    const msg = JSON.parse(out[0]!);
    expect(msg.id).toBe(9);
    const { properties, required } = msg.params.requestedSchema;
    expect(required).toEqual([]);
    expect(Object.keys(properties)).toEqual(["q_0", "q_1"]);
    expect(properties.q_0).toEqual({ type: "string", title: "Rotate the tokens?", description: "Rotate the tokens?", enum: ["Yes", "No", "Skip this question"] });
    expect(properties.q_1.enum).toEqual(["auth.test.ts", "Skip this question"]);
    expect(JSON.stringify(msg)).not.toContain("oneOf");
  });

  test("a chosen option reaches the agent as its own value", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    const back = r.fromClient(answer(9, { q_0: "No", q_1: "auth.test.ts" }));
    expect(JSON.parse(back!)).toEqual({ jsonrpc: "2.0", id: 9, result: { action: "accept", content: { q_0: "No", q_1: "auth.test.ts" } } });
  });

  test("a label that differs from its value maps back to the value", async () => {
    const { r } = relay();
    const form = JSON.parse(zcodeForm());
    form.params.requestedSchema.properties.q_0.oneOf = [{ const: "yes-1", title: "Yes" }, { const: "yes-2", title: "Yes" }, { const: "__skip__", title: "Skip this question" }];
    const out = JSON.parse((await r.fromAgent(JSON.stringify(form)))[0]!);
    expect(out.params.requestedSchema.properties.q_0.enum).toEqual(["Yes", "Yes (2)", "Skip this question"]);
    expect(JSON.parse(r.fromClient(answer(9, { q_0: "Yes (2)" }))!).result.content).toEqual({ q_0: "yes-2" });
  });

  test("the skip button maps back to the skip value", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    const back = r.fromClient(answer(9, { q_0: "Skip this question", q_1: "auth.test.ts" }));
    expect(JSON.parse(back!).result.content).toEqual({ q_0: "__skip__", q_1: "auth.test.ts" });
  });

  test("typed text reaches the agent in the companion field, and a blank answer is left out", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    const back = r.fromClient(answer(9, { q_0: "Only the old one", q_1: "  " }));
    expect(JSON.parse(back!).result.content).toEqual({ q_0_other: "Only the old one" });
  });

  test("a cancelled form and an unrelated answer pass unchanged", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    expect(r.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { action: "accept", content: {} } }))).toBeUndefined();
    const cancel = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { action: "cancel" } });
    expect(JSON.parse(r.fromClient(cancel)!)).toEqual({ jsonrpc: "2.0", id: 9, result: { action: "cancel" } });
  });

  test("a client error answer, a cancel request and the session end drop the stored form", async () => {
    const { r } = relay();
    const forms = () => (r as unknown as { forms: Map<string, unknown> }).forms.size;
    await r.fromAgent(zcodeForm(1));
    await r.fromAgent(zcodeForm(2));
    await r.fromAgent(zcodeForm(3));
    expect(forms()).toBe(3);
    expect(r.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }))).toBeUndefined();
    expect(forms()).toBe(2);
    expect(r.fromClient(JSON.stringify({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 2 } }))).toBeUndefined();
    expect(forms()).toBe(1);
    r.clearForms();
    expect(forms()).toBe(0);
  });

  test("a multi-select form and other forms pass byte for byte", async () => {
    const { r } = relay();
    const multi = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "elicitation/create", params: { mode: "form", sessionId: "s1", message: "Pick", requestedSchema: { type: "object", properties: { q_0: { type: "array", title: "Pick", items: { anyOf: [{ const: "a", title: "A" }] } }, q_0_other: { type: "string" } } } } });
    expect(await r.fromAgent(multi)).toEqual([multi]);
    const plan = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "elicitation/create", params: { mode: "form", sessionId: "s1", message: "Exit plan mode", requestedSchema: { type: "object", properties: { approval: { type: "string", oneOf: [{ const: "approve", title: "Approve" }] } }, required: ["approval"] } } });
    expect(await r.fromAgent(plan)).toEqual([plan]);
    const off = relay(false);
    expect(await off.r.fromAgent(zcodeForm())).toEqual([zcodeForm()]);
  });
});
