import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  LoginFlowManager,
  extractFlowSignals,
  extractPasteValue,
  firstAuthUrl,
  firstDeviceCode,
  type SpawnedChild,
} from "../../src/server/login-flows.ts";
import { HttpError } from "../../src/server/types.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

/** A controllable fake child: test code pushes output chunks and resolves
 * the exit; kill() records the signal and (by default) resolves the exit
 * like a terminated process would. */
class FakeChild {
  readonly writes: string[] = [];
  readonly kills: (string | number | undefined)[] = [];
  exited: Promise<number | null | undefined>;
  private resolveExitPublic: (code: number | null | undefined) => void = () => {};
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly stream: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();
  pid = 4242;

  constructor(private readonly autoResolveOnKill = true) {
    this.exited = new Promise((resolve) => {
      this.resolveExitPublic = resolve;
    });
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  private get iterable(): AsyncIterable<Uint8Array> {
    return this.stream as unknown as AsyncIterable<Uint8Array>;
  }

  get stdout(): AsyncIterable<Uint8Array> {
    return this.iterable;
  }

  get stderr(): AsyncIterable<Uint8Array> {
    return this.iterable;
  }

  get stdin() {
    return {
      write: (data: string | Uint8Array): number => {
        this.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        return data.length;
      },
      end: () => {},
    };
  }

  push(text: string): void {
    this.controller.enqueue(this.encoder.encode(text));
  }

  close(): void {
    this.controller.close();
  }

  resolveExit(code: number | null | undefined): void {
    this.close();
    this.resolveExitPublic(code);
  }

  kill(signal?: number | string): void {
    this.kills.push(signal);
    if (this.autoResolveOnKill) this.resolveExit(null);
  }
}

interface Harness {
  manager: LoginFlowManager;
  children: FakeChild[];
  commands: string[][];
  fingerprint: { value: string | undefined };
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const children: FakeChild[] = [];
  const commands: string[][] = [];
  const fingerprint: { value: string | undefined } = { value: undefined };
  const manager = new LoginFlowManager({
    scriptBin: "/usr/bin/script",
    pollIntervalMs: 5,
    flowTimeoutMs: 60_000,
    spawn: (cmd) => {
      commands.push(cmd);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as SpawnedChild;
    },
    resolveBin: () => "/usr/bin/env-test-binary",
    resolveIdentity: async (toolName: ToolConfig["toolName"]) => {
      const cfg: ToolConfig = {
        toolName,
        realBinaryName: toolName === "zai" || toolName === "ali" ? "crush" : (toolName as ToolConfig["realBinaryName"]),
        envVarName: toolName === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME",
        globalMemoryProjection: toolName === "claude" ? "claude-append-file" : "codex-developer-instructions",
        identitiesJsonPath: "/tmp/does-not-matter.json",
        identitiesRootDir: "/tmp/does-not-matter",
      };
      return { cfg, configDir: "/tmp/identity-config", identityName: "work" };
    },
    fingerprint: async () => fingerprint.value,
    ...overrides,
  });
  return { manager, children, commands, fingerprint };
}

const CODEX_ENV = { CODEX_HOME: "/tmp/identity-config" };

async function waitFor(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("output parsing", () => {
  test("extracts an auth URL from claude-style OSC-8 wrapped PTY output", () => {
    const line = "If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc\x1b\\";
    expect(firstAuthUrl(line)).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=abc");
  });

  test("prefers auth-relevant URLs over unrelated ones", () => {
    const text = "see https://example.com/docs and https://accounts.x.ai/oauth2/device?user_code=VJ4X-PRA4";
    expect(firstAuthUrl(text)).toBe("https://accounts.x.ai/oauth2/device?user_code=VJ4X-PRA4");
  });

  test("extracts device codes", () => {
    expect(firstDeviceCode("Enter this one-time code (expires in 15 minutes)\n   4L6A-6ISQH")).toBe("4L6A-6ISQH");
    expect(firstDeviceCode("Confirm this code in your browser:\n\n  VJ4X-PRA4")).toBe("VJ4X-PRA4");
    expect(firstDeviceCode("no code here")).toBeUndefined();
  });

  test("extracts a colour-coded device code whose ANSI escapes merge with the text", () => {
    // codex renders the code as ESC[94m4L6A-6ISQH ESC[0m: the trailing "m"
    // byte merges with the code unless escapes are reduced first.
    const raw = "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m4L6A-6ISQH\x1b[0m\n";
    expect(extractFlowSignals(raw).deviceCode).toBe("4L6A-6ISQH");
  });

  test("OSC-8 hyperlink wrappers are unwrapped, keeping the URL itself", () => {
    const raw = "visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc\x1b\\\n";
    expect(extractFlowSignals(raw).url).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=abc");
  });

  test("extractPasteValue pulls the code out of a pasted redirect URL", () => {
    expect(extractPasteValue("https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz")).toBe("abc123");
    expect(extractPasteValue("  plain-code-42 ")).toBe("plain-code-42");
  });
});

describe("LoginFlowManager", () => {
  test("start builds a piped device-auth command for codex with identity env", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    expect(flow.status).toBe("starting");
    expect(flow.mode).toBe("pipes");
    expect(flow.acceptsPaste).toBe(false);
    expect(h.commands[0]).toEqual(["/usr/bin/env-test-binary", "login", "--device-auth"]);
    expect(flow.flowId.length).toBeGreaterThan(0);
    h.children[0].resolveExit(0);
  });

  test("start builds a script PTY command for claude", async () => {
    const h = harness();
    await h.manager.start("claude", "work");
    const cmd = h.commands[0];
    expect(cmd[0]).toBe("/usr/bin/script");
    expect(cmd.slice(1, 4)).toEqual(["-qfec", "'/usr/bin/env-test-binary' 'auth' 'login'", "/dev/null"]);
    h.children[0].resolveExit(0);
  });

  test("claude flow surfaces the auth URL from output and enters waiting", async () => {
    const h = harness();
    const flow = await h.manager.start("claude", "work");
    h.children[0].push("If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc\x1b\\\n");
    await waitFor(() => h.manager.get(flow.flowId).status === "waiting");
    const dto = h.manager.get(flow.flowId);
    expect(dto.authUrl).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=abc");
    expect(dto.acceptsPaste).toBe(true);
    h.children[0].resolveExit(0);
  });

  test("codex flow surfaces the device URL and one-time code", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    h.children[0].push("1. Open this link in your browser\n   https://auth.openai.com/codex/device\n2. Enter this one-time code 4L6A-6ISQH\n");
    await waitFor(() => h.manager.get(flow.flowId).deviceCode === "4L6A-6ISQH");
    const dto = h.manager.get(flow.flowId);
    expect(dto.authUrl).toBe("https://auth.openai.com/codex/device");
    expect(dto.status).toBe("waiting");
    h.children[0].resolveExit(0);
  });

  test("submit injects the pasted code plus newline on stdin", async () => {
    const h = harness();
    const flow = await h.manager.start("claude", "work");
    h.children[0].push("visit \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc\x1b\\");
    await waitFor(() => h.manager.get(flow.flowId).status === "waiting");
    h.manager.submit(flow.flowId, "https://platform.claude.com/oauth/code/callback?code=XYZ&state=s");
    await waitFor(() => h.children[0].writes.length > 0);
    expect(h.children[0].writes[0]).toBe("XYZ\n");
    h.children[0].resolveExit(0);
  });

  test("submit rejects flows that do not accept paste", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    expect(() => h.manager.submit(flow.flowId, "4L6A-6ISQH")).toThrow(HttpError);
    h.children[0].resolveExit(0);
  });

  test("clean exit completes the flow", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    h.children[0].resolveExit(0);
    await waitFor(() => h.manager.get(flow.flowId).status === "completed");
    expect(h.manager.get(flow.flowId).endedAt).toBeDefined();
  });

  test("a credential fingerprint change moves waiting to callback", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    h.children[0].push("https://auth.openai.com/codex/device 4L6A-6ISQH");
    await waitFor(() => h.manager.get(flow.flowId).status === "waiting");
    h.fingerprint.value = "/tmp/identity-config/auth.json:123:456";
    await waitFor(() => h.manager.get(flow.flowId).status === "callback");
    h.children[0].resolveExit(0);
    await waitFor(() => h.manager.get(flow.flowId).status === "completed");
  });

  test("non-zero exit fails the flow with a redacted message", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    h.children[0].push("error: token AAAAAA11111AAAAA22222AAAAA3333 rejected\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.children[0].resolveExit(1);
    await waitFor(() => h.manager.get(flow.flowId).status === "failed");
    const dto = h.manager.get(flow.flowId);
    expect(dto.error).toContain("rejected");
    expect(dto.error).not.toContain("AAAAAA11111");
    expect(dto.error).toContain("<redacted>");
  });

  test("a non-zero exit after observed credentials still completes", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    h.fingerprint.value = "/tmp/identity-config/auth.json:123:456";
    await waitFor(() => h.manager.get(flow.flowId).status === "callback");
    h.children[0].resolveExit(2);
    await waitFor(() => h.manager.get(flow.flowId).status === "completed");
  });

  test("cancel kills the child and marks the flow cancelled", async () => {
    const h = harness();
    const flow = await h.manager.start("codex", "work");
    const dto = h.manager.cancel(flow.flowId);
    expect(dto.status).toBe("cancelled");
    expect(h.children[0].kills.length).toBeGreaterThan(0);
    expect(h.manager.get(flow.flowId).endedAt).toBeDefined();
  });

  test("starting a second flow for the same tool/identity conflicts", async () => {
    const h = harness();
    const first = await h.manager.start("codex", "work");
    try {
      await h.manager.start("codex", "work");
      throw new Error("expected 409");
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
    }
    h.manager.cancel(first.flowId);
  });

  test("unknown tool names have no managed flow", async () => {
    const h = harness();
    try {
      await h.manager.start("opencode", "work");
      throw new Error("expected 400");
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });

  test("unknown flow ids 404", () => {
    const h = harness();
    try {
      h.manager.get("nope");
      throw new Error("expected 404");
    } catch (err) {
      expect((err as HttpError).status).toBe(404);
    }
  });

  test("flows time out and are killed", async () => {
    const h = harness({ flowTimeoutMs: 30 });
    const flow = await h.manager.start("codex", "work");
    await waitFor(() => h.manager.get(flow.flowId).status === "failed");
    expect(h.manager.get(flow.flowId).error).toContain("timed out");
    expect(h.children[0].kills.length).toBeGreaterThan(0);
  });

  test("stop() cancels every active flow", async () => {
    const h = harness();
    const a = await h.manager.start("codex", "work");
    const b = await h.manager.start("kimi", "work");
    h.manager.stop();
    expect(h.manager.get(a.flowId).status).toBe("cancelled");
    expect(h.manager.get(b.flowId).status).toBe("cancelled");
  });

  test("ended flows are pruned down to the retention cap", async () => {
    const h = harness({ maxEndedFlows: 1, keepEndedMs: 0 });
    const a = await h.manager.start("codex", "work");
    h.children[0].resolveExit(0);
    await waitFor(() => h.manager.get(a.flowId).status === "completed");
    const b = await h.manager.start("kimi", "work");
    h.children[1].resolveExit(0);
    await waitFor(() => h.manager.get(b.flowId).status === "completed");
    h.manager.list(); // triggers prune
    const flows = h.manager.list();
    expect(flows.filter((f) => f.status === "completed").length).toBeLessThanOrEqual(1);
  });
});

describe("default fingerprint probe", () => {
  test("reflects file presence, mtime and size without reading contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-flows-"));
    const path = join(dir, "auth.json");
    const manager = new LoginFlowManager({ spawn: () => new FakeChild() as unknown as SpawnedChild });
    const before = await (manager as unknown as { fingerprint: (paths: string[]) => Promise<string | undefined> }).fingerprint([path]);
    expect(before).toBeUndefined();
    await Bun.write(path, "{}\n");
    const after = await (manager as unknown as { fingerprint: (paths: string[]) => Promise<string | undefined> }).fingerprint([path]);
    expect(after).toContain(path);
    expect(after).not.toContain("{}");
  });
});
