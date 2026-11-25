import { describe, expect, test } from "bun:test";
import { ErrorPeek, ERROR_MESSAGE_MAX, failureName, redactText, summariseUpstreamError } from "../../src/gateway/upstream-error.ts";

const enc = new TextEncoder();
const of = (v: unknown) => summariseUpstreamError(enc.encode(typeof v === "string" ? v : JSON.stringify(v)));

describe("summariseUpstreamError", () => {
  test("reads each provider's error shape", () => {
    expect(of({ type: "error", error: { type: "invalid_request_error", message: "messages.3: image exceeds 5 MB maximum" } })).toEqual({ type: "invalid_request_error", message: "messages.3: image exceeds 5 MB maximum" });
    expect(of({ error: { message: "Invalid request Error", type: "invalid_request_error", param: null, code: null } })).toEqual({ type: "invalid_request_error", message: "Invalid request Error" });
    expect(of({ error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } })).toEqual({ type: "invalid_request_error", code: "model_not_found", message: "The model does not exist" });
    expect(of({ detail: "Stream must be set to true" })).toEqual({ message: "Stream must be set to true" });
    expect(of({ detail: { code: "deactivated_workspace", message: "no access" } })).toEqual({ code: "deactivated_workspace", message: "no access" });
    expect(of({ error: "MissingSessionID" })).toEqual({ message: "MissingSessionID" });
    expect(of({ code: 1113, message: "Insufficient balance" })).toEqual({ code: "1113", message: "Insufficient balance" });
  });

  test("reads an error sent as an event stream", () => {
    expect(of('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')).toEqual({ type: "overloaded_error", message: "Overloaded" });
  });

  test("a body that is not JSON gives its words, without markup", () => {
    expect(of("<html><head><style>b{}</style></head><body><h1>502 Bad Gateway</h1></body></html>")).toEqual({ message: "502 Bad Gateway" });
    expect(of("upstream connect error")).toEqual({ message: "upstream connect error" });
    expect(of("")).toBeUndefined();
    expect(of("{}")).toBeUndefined();
  });

  test("credential-shaped text never reaches the log", () => {
    // Built from pieces so that no token-shaped literal sits in the repository.
    const jwt = [btoa(JSON.stringify({ alg: "none" })), btoa(JSON.stringify({ sub: "SYNTHETIC_FIXTURE" })), "c2lnbmF0dXJl"].join(".").replace(/=/g, "");
    const s = of({ error: { type: "authentication_error", message: `bad key sk-SYNTHETIC_FIXTURE_0123456789abcdef and Bearer SYNTHETIC_FIXTURE.tok-en for person@example.com with ${jwt} and aisg_SYNTHETIC_FIXTURE_abcdefgh` } });
    expect(s?.message).toBe("bad key [redacted] and Bearer [redacted] for [email] with [redacted] and [redacted]");
    expect(redactText(`data:image/png;base64,${"QUJD".repeat(40)}`)).toBe("data:image/png;base64,[redacted]");
  });

  test("a long message is cut", () => {
    const m = of({ error: { message: "word ".repeat(400) } })?.message ?? "";
    expect(m.length).toBe(ERROR_MESSAGE_MAX);
    expect(m.endsWith("…")).toBe(true);
  });
});

describe("ErrorPeek", () => {
  test("keeps only the first bytes of the body", () => {
    const p = new ErrorPeek(64);
    p.write(enc.encode('{"error":{"message":"Invalid '));
    p.write(enc.encode('request Error"}}'));
    p.write(enc.encode("x".repeat(500)));
    expect(p.summary()).toEqual({ message: '{"error":{"message":"Invalid request Error"}}xxxxxxxxxxxxxxxxxxx' });
    const whole = new ErrorPeek(1024);
    whole.write(enc.encode('{"error":{"message":"Invalid '));
    whole.write(enc.encode('request Error"}}'));
    expect(whole.summary()).toEqual({ message: "Invalid request Error" });
    expect(new ErrorPeek(8).summary()).toBeUndefined();
  });
});

describe("failureName", () => {
  test("gives a code or class name, never a message", () => {
    expect(failureName(Object.assign(new Error("connect to upstream host failed"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(failureName(new DOMException("took too long", "TimeoutError"))).toBe("TimeoutError");
    expect(failureName(new Error("secret text"))).toBeUndefined();
    expect(failureName(Object.assign(new Error("x"), { code: "not a code!" }))).toBeUndefined();
    expect(failureName(undefined)).toBeUndefined();
  });
});

test("redactText removes id.secret keys and the value after a secret-looking name, and keeps the name", () => {
  const idKey = `${"0123456789abcdef".repeat(2)}.${"AbCdEfGh".repeat(2)}`; // built here, not written out: no key-shaped literal
  expect(redactText(`auth failed for ${idKey} today`)).toBe("auth failed for [redacted] today");
  expect(redactText("api_key=short1 and apikey: v2 and API-KEY = v3")).toBe("api_key=[redacted] and apikey: [redacted] and API-KEY = [redacted]");
  expect(redactText("password: hunter2 secret=abc token:xyz")).toBe("password: [redacted] secret=[redacted] token:[redacted]");
  expect(redactText("x-api-key: abc123 client_secret=abc")).toBe("x-api-key: [redacted] client_secret=[redacted]");
  expect(redactText('{"token":"abc","n":1}')).toBe('{"token":[redacted]');
  expect(redactText("authorization: Bearer abc_SYNTHETIC_FIXTURE_123")).not.toContain("SYNTHETIC_FIXTURE");
  // plain words are not changed
  expect(redactText("max_tokens exceeded, token limit reached")).toBe("max_tokens exceeded, token limit reached");
});
