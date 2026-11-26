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
  test("the form reaches the client in the shape T3 shows as option buttons", async () => {
    const { r } = relay();
    const out = await r.fromAgent(zcodeForm());
    expect(out.length).toBe(1);
    const msg = JSON.parse(out[0]!);
    expect(msg.id).toBe(9);
    const { properties, required } = msg.params.requestedSchema;
    expect(required).toEqual(["question_1", "question_2"]);
    expect(Object.keys(properties).length).toBe(4);
    expect(properties.question_1).toEqual({
      type: "string",
      title: "Rotate the tokens?",
      description: "Rotate the tokens?",
      oneOf: [{ const: "option_1", title: "Yes" }, { const: "option_2", title: "No" }, { const: "other", title: "Other" }],
    });
    expect(properties.question_1_other).toEqual({ type: "string" });
    expect(properties.question_2.oneOf.map((o: { title: string }) => o.title)).toEqual(["auth.test.ts", "Other"]);
    expect(JSON.stringify(msg)).not.toContain("__skip__");
  });

  test("a chosen option reaches the agent as its own value", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    const back = r.fromClient(answer(9, { question_1: "option_2", question_2: "option_1" }));
    expect(JSON.parse(back!)).toEqual({ jsonrpc: "2.0", id: 9, result: { action: "accept", content: { q_0: "No", q_1: "auth.test.ts" } } });
  });

  test("a typed answer reaches the agent in the companion field", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    const back = r.fromClient(answer(9, { question_1: "other", question_1_other: "Only the old one", question_2: "option_1" }));
    expect(JSON.parse(back!).result.content).toEqual({ q_0_other: "Only the old one", q_1: "auth.test.ts" });
  });

  test("a cancelled form and an unrelated answer pass unchanged", async () => {
    const { r } = relay();
    await r.fromAgent(zcodeForm());
    expect(r.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { action: "accept", content: {} } }))).toBeUndefined();
    const cancel = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { action: "cancel" } });
    expect(JSON.parse(r.fromClient(cancel)!)).toEqual({ jsonrpc: "2.0", id: 9, result: { action: "cancel" } });
  });

  test("other forms and agents without the rule pass byte for byte", async () => {
    const { r } = relay();
    const plan = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "elicitation/create", params: { mode: "form", sessionId: "s1", message: "Exit plan mode", requestedSchema: { type: "object", properties: { approval: { type: "string", oneOf: [{ const: "approve", title: "Approve" }] } }, required: ["approval"] } } });
    expect(await r.fromAgent(plan)).toEqual([plan]);
    const off = relay(false);
    expect(await off.r.fromAgent(zcodeForm())).toEqual([zcodeForm()]);
  });
});
