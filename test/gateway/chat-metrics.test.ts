import { describe, expect, test } from "bun:test";
import { noopMetrics, PrometheusMetrics } from "../../src/gateway/metrics.ts";

describe("chat metrics", () => {
  test("render() contains the five series after one call each", () => {
    const m = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    m.chatSession("session_created");
    m.chatTurn("ok");
    m.chatError("attach");
    m.chatPodStart(1.5);
    m.chatGauges.active = () => 3;
    const out = m.render();
    expect(out).toContain('ais_gateway_chat_sessions_total{event="session_created"} 1');
    expect(out).toContain('ais_gateway_chat_turns_total{outcome="ok"} 1');
    expect(out).toContain('ais_gateway_chat_errors_total{kind="attach"} 1');
    expect(out).toContain('ais_gateway_chat_pod_start_seconds_bucket{le="2.5"} 1');
    expect(out).toContain("ais_gateway_chat_pod_start_seconds_sum 1.5");
    expect(out).toContain("ais_gateway_chat_pod_start_seconds_count 1");
    expect(out).toContain("ais_gateway_chats_active 3");
  });

  test("the active gauge renders 0 until set", () => {
    expect(new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 }).render()).toContain("ais_gateway_chats_active 0");
  });

  test("an unknown label value is rendered as other", () => {
    const m = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    m.chatSession("bogus");
    m.chatTurn("bogus");
    m.chatError("bogus");
    const out = m.render();
    expect(out).toContain('ais_gateway_chat_sessions_total{event="other"} 1');
    expect(out).toContain('ais_gateway_chat_turns_total{outcome="other"} 1');
    expect(out).toContain('ais_gateway_chat_errors_total{kind="other"} 1');
    expect(out).not.toContain("bogus");
  });

  test("limit is its own error kind and unavailable is its own MCP outcome", () => {
    const m = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    m.chatError("limit");
    m.browserMcpRequest("delete", "unavailable");
    const out = m.render();
    expect(out).toContain('ais_gateway_chat_errors_total{kind="limit"} 1');
    expect(out).toContain('outcome="unavailable"');
  });

  test("noopMetrics has the four methods", () => {
    expect(() => {
      noopMetrics.chatSession("session_created");
      noopMetrics.chatTurn("ok");
      noopMetrics.chatError("other");
      noopMetrics.chatPodStart(1);
    }).not.toThrow();
  });
});
