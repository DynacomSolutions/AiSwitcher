import { createHash } from "node:crypto";

/**
 * Downloads a GitHub release asset through the REST API (asset id, `Accept: application/octet-stream`)
 * instead of the browser download URL, which is served by a separate path that can fail on its own.
 * The asset is found by tag and name; `expectedSha256` pins the bytes, otherwise the digest the API
 * reports for the asset is checked.
 */
export async function downloadReleaseAsset(
  repo: string, tag: string, name: string, token: string | undefined, expectedSha256?: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const headers: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ais-ci" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releaseResponse = await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: { ...headers, Accept: "application/vnd.github+json" } });
  if (!releaseResponse.ok) throw new Error(`Release ${repo}@${tag} lookup failed: HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json() as { assets?: Array<{ id: number; name: string; digest?: string | null }> };
  const asset = release.assets?.find((entry) => entry.name === name);
  if (!asset) throw new Error(`Release ${repo}@${tag} has no asset ${name}`);
  const expected = (expectedSha256 ?? asset.digest?.replace(/^sha256:/, ""))?.toLowerCase();
  if (!expected) throw new Error(`No checksum available for ${repo}@${tag}/${name}`);
  // Do not forward the token to the storage host the API redirects to.
  const redirect = await fetcher(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, { headers: { ...headers, Accept: "application/octet-stream" }, redirect: "manual" });
  let response = redirect;
  if (redirect.status >= 300 && redirect.status < 400) {
    const location = redirect.headers.get("location");
    if (!location) throw new Error(`Asset ${name} redirect has no location`);
    response = await fetcher(location, { headers: { "User-Agent": "ais-ci" } });
  }
  if (!response.ok) throw new Error(`Asset ${repo}@${tag}/${name} download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  return bytes;
}

/** Retries a download a few times with a growing pause. */
export async function withRetries<T>(operation: () => Promise<T>, attempts = 4, delayMs = 5_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`${error instanceof Error ? error.message : error} (attempt ${attempt}/${attempts}); retrying.`);
      await Bun.sleep(delayMs * attempt);
    }
  }
}

if (import.meta.main) {
  const [repo, tag, name, output, sha256] = Bun.argv.slice(2);
  if (!repo || !tag || !name || !output) throw new Error("usage: github-release-asset.ts <owner/repo> <tag> <asset> <output> [sha256]");
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  await Bun.write(output, await withRetries(() => downloadReleaseAsset(repo, tag, name, token, sha256)));
}
