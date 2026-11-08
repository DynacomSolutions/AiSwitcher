import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { downloadReleaseAsset } from "../../scripts/host/github-release-asset";

const bytes = new TextEncoder().encode("asset bytes");
const sha = createHash("sha256").update(bytes).digest("hex");

function fakeGitHub(calls: Array<{ url: string; auth: string | null }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/releases/tags/v1")) return Response.json({ assets: [{ id: 7, name: "tool", digest: `sha256:${sha}` }] });
    if (url.endsWith("/releases/assets/7")) return new Response(null, { status: 302, headers: { location: "https://objects.example/tool" } });
    if (url === "https://objects.example/tool") return new Response(bytes);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

describe("release asset download through the API", () => {
  test("looks the asset up by tag and name, and keeps the token off the storage host", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    expect(await downloadReleaseAsset("o/r", "v1", "tool", "tok", undefined, fakeGitHub(calls))).toEqual(bytes);
    expect(calls.map((call) => call.auth)).toEqual(["Bearer tok", "Bearer tok", null]);
  });

  test("rejects a checksum mismatch and a missing asset", async () => {
    await expect(downloadReleaseAsset("o/r", "v1", "tool", "tok", "0".repeat(64), fakeGitHub([]))).rejects.toThrow("Checksum mismatch");
    await expect(downloadReleaseAsset("o/r", "v1", "other", "tok", undefined, fakeGitHub([]))).rejects.toThrow("no asset other");
  });
});
