import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserUpload } from "../../src/cli/browser/upload.ts";

let root: string;
let reg: string;
let cfg: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ais-upload-test-"));
  cfg = join(root, "ids", "work");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "ais-browser-token"), "SYNTHETIC_FIXTURE-tok\n");
  writeFileSync(join(root, "a.txt"), "hello");
  reg = join(root, "identities.json");
  writeFileSync(reg, JSON.stringify({ version: 1, identities: [{ name: "work", label: "w", configDir: cfg }] }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Seen { url: string; auth: string | null; body: any }
function deps(seen: Seen[], reply: unknown = { id: "1", ok: true, content: [{ type: "text", text: "uploaded 1 file" }] }, status = 200) {
  const out: string[] = [];
  return {
    out,
    d: {
      env: { CLAUDE_CONFIG_DIR: cfg } as NodeJS.ProcessEnv,
      registryPath: () => reg,
      gatewayUrl: async () => "https://gw.example.test/gateway/",
      out: (l: string) => out.push(l),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(reply), { status });
      }) as unknown as typeof fetch,
    },
  };
}

test("posts one upload_file call with file content and the session id", async () => {
  const seen: Seen[] = [];
  const { d, out } = deps(seen);
  const ok = await runBrowserUpload(["--session", "sess-1", "--tab", "4", "--ref", "ref_2", "--browser", "work-chrome", join(root, "a.txt")], d);
  expect(ok).toBe(true);
  expect(out).toEqual(["uploaded 1 file"]);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe("https://gw.example.test/gateway/browser/call");
  expect(seen[0]!.auth).toBe("Bearer SYNTHETIC_FIXTURE-tok");
  expect(seen[0]!.body).toMatchObject({ browser: "work-chrome", session: { id: "sess-1", identity: "work" }, tool: "upload_file", args: { tabId: 4, ref: "ref_2" } });
  expect(seen[0]!.body.args.files).toEqual([{ name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") }]);
  expect(seen[0]!.body.args.paths).toBeUndefined();
});

test("coordinate form, and a tool failure returns false", async () => {
  const seen: Seen[] = [];
  const { d, out } = deps(seen, { id: "1", ok: false, error: "forbidden_tab", message: "not yours" });
  expect(await runBrowserUpload(["--session=s", "--tab=1", "--coordinate=10,20", join(root, "a.txt")], d)).toBe(false);
  expect(seen[0]!.body.args.coordinate).toEqual([10, 20]);
  expect(out).toEqual(["forbidden_tab: not yours"]);
});

test("usage errors: missing session, tab, target, paths; both ref and coordinate", async () => {
  const f = join(root, "a.txt");
  const run = (argv: string[]) => runBrowserUpload(argv, deps([]).d);
  await expect(run(["--tab", "1", "--ref", "r", f])).rejects.toThrow("--session");
  await expect(run(["--session", "s", "--ref", "r", f])).rejects.toThrow("--tab");
  await expect(run(["--session", "s", "--tab", "1", f])).rejects.toThrow("exactly one");
  await expect(run(["--session", "s", "--tab", "1", "--ref", "r", "--coordinate", "1,2", f])).rejects.toThrow("exactly one");
  await expect(run(["--session", "s", "--tab", "1", "--ref", "r"])).rejects.toThrow("file path");
});

test("file limits are the existing ones: a missing file posts nothing", async () => {
  const seen: Seen[] = [];
  await expect(runBrowserUpload(["--session", "s", "--tab", "1", "--ref", "r", join(root, "missing.txt")], deps(seen).d)).rejects.toThrow("not a file");
  expect(seen).toHaveLength(0);
});

test("a gateway error status is reported", async () => {
  const seen: Seen[] = [];
  await expect(runBrowserUpload(["--session", "s", "--tab", "1", "--ref", "r", join(root, "a.txt")], deps(seen, { error: "unauthorised" }, 401).d)).rejects.toThrow("401 (unauthorised)");
});

test("no identity for the env folder is a usage error", async () => {
  const seen: Seen[] = [];
  const { d } = deps(seen);
  await expect(runBrowserUpload(["--session", "s", "--tab", "1", "--ref", "r", join(root, "a.txt")], { ...d, env: {} })).rejects.toThrow("cannot tell which identity");
  expect(seen).toHaveLength(0);
});
