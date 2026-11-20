import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, relative, sep } from "node:path";
import { memberDir, memberLoginFile, type MemberStoreTool } from "../identities/gateway-members.ts";
import { hostStoreConfig, type HostStoreConfig } from "./host-sync.ts";
import { HttpHomeStore } from "./home-store-http.ts";
import { sha256Hex, type HomeStoreClient } from "./home-store.ts";
import { REPLACED_MARKER_FILE } from "./home-mirror.ts";

/**
 * Pushes a member-store login the owner just adopted into the credential store through the gateway admin API, replacing the rows at once so
 * cluster gateways serve the new account without waiting for the host sync. Each row is replaced by compare-and-swap on the
 * version just read (account key `<tool>/<identity>` unchanged). Never throws: the local write stands, and the host store
 * sync (`ais gateway store sync`) is the fallback.
 */

export interface OwnerPushOptions {
  root: string;
  home?: string;
  /** Tests: an open store instead of one made from the config. */
  store?: HomeStoreClient;
  /** Tests: a config instead of the environment and ~/.secrets. */
  config?: HostStoreConfig | undefined;
  env?: Record<string, string | undefined>;
  secretsPath?: string;
}

const ATTEMPTS = 3;

export async function pushOwnerLogin(tool: MemberStoreTool, name: string, opts: OwnerPushOptions): Promise<string> {
  const home = opts.home ?? homedir();
  let store = opts.store;
  let own = false;
  try {
    if (!store) {
      const cfg = "config" in opts ? opts.config : await hostStoreConfig(opts.env ?? process.env, opts.secretsPath);
      if (!cfg) return "no store config in this process, so the new login reaches the PostgreSQL store through the host sync (ais gateway store sync)";
      if (cfg.databaseUrl) {
        // The direct database path, only with AIS_GATEWAY_STORE_DIRECT=1 (host-sync.ts).
        const { PgHomeStore } = await import("./home-store.ts");
        store = new PgHomeStore(cfg.databaseUrl, cfg.key, `owner-adopt:${hostname()}:${process.pid}`);
      } else store = new HttpHomeStore({ url: cfg.admin!.url, token: cfg.admin!.token, key: cfg.key });
      own = true;
    }
    const dir = memberDir(tool, name, opts.root);
    // The marker goes first, so the guard is in the store before the new login lands.
    const files = [REPLACED_MARKER_FILE, memberLoginFile(tool), ...(tool === "claude" ? [".claude.json"] : [])];
    const pushed: string[] = [];
    for (const file of files) {
      const abs = join(dir, file);
      const rel = relative(home, abs);
      if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return "the member store is outside HOME, so the host sync cannot see it; nothing was pushed to the PostgreSQL store";
      const content = await readFile(abs).catch(() => undefined);
      if (!content) continue;
      const relPath = rel.split(sep).join("/");
      const kind = file === REPLACED_MARKER_FILE ? "marker" : "login";
      let done = false;
      for (let i = 0; i < ATTEMPTS && !done; i++) {
        const [row] = await store.get([relPath]);
        if (row && row.sha256 === sha256Hex(content)) {
          done = true;
          break;
        }
        const r = await store.put(relPath, content, { account: `${tool}/${name}`, kind, expectedVersion: row ? row.version : null });
        done = r.ok;
      }
      if (!done) return `the PostgreSQL store row for ${relPath} kept changing; the host sync will push it`;
      pushed.push(relPath);
    }
    return `pushed ${pushed.length} file${pushed.length === 1 ? "" : "s"} to the PostgreSQL store`;
  } catch (err) {
    return `could not push to the PostgreSQL store (${err instanceof Error ? err.name : "error"}); the host sync will push it`;
  } finally {
    if (own) await store?.close().catch(() => undefined);
  }
}
