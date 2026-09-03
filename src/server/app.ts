import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
import pkg from "../../package.json" with { type: "json" };
import { runBackup } from "../../scripts/backup.ts";
import { TOOL_CONFIGS, loadAll } from "../cli/identities/resolve-tool.ts";
import { resolveRealBinary } from "../shared/resolve-binary.ts";
import { aisHome } from "../shared/ais-home.ts";
import type { ToolConfig } from "../identities/types.ts";
import { consoleGuard, type GuardDeps } from "./guard.ts";
import { type AuthRefreshScheduler } from "./auth-refresh.ts";
import { HttpError } from "./types.ts";
import * as authApi from "./auth.ts";
import { runScanIsolated } from "./workers.ts";
import {
  createIdentityInRegistry,
  deleteIdentityFromRegistry,
  listRegistries,
  mutateAlias,
  mutateDirectory,
  updateIdentityInRegistry,
} from "./registries.ts";
import { scanProcesses } from "./processes.ts";
import * as filesApi from "./files.ts";

export interface ConsoleAppDeps extends GuardDeps {
  startedAt: number;
  /** apps/web/dist when present; the SPA plus its assets are served from here. */
  distDir?: string;
  /** Daemon-side credential renewal; absent in bare-app tests. */
  authRefresh?: AuthRefreshScheduler;
}

export function createApp(deps: ConsoleAppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error("console: unhandled error:", err);
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });

  // Unauthenticated liveness probe BEFORE the guard: k8s probes and uptime
  // checks have no per-boot bearer token, and this must leak nothing beyond
  // what an HTTP response line already does.
  app.get("/api/health", (c) => c.json({ ok: true as const, version: pkg.version }));

  app.use("/api/*", (c, next) => consoleGuard(deps, c, next));

  /* --------------------------------- status -------------------------------- */

  app.get("/api/status", async (c) => {
    const loaded = await loadAll();
    const tools = await Promise.all(
      loaded.map(async ({ cfg }) => ({
        toolName: cfg.toolName,
        realBinaryName: cfg.realBinaryName,
        registryPath: cfg.identitiesJsonPath,
        registryExists: await Bun.file(cfg.identitiesJsonPath)
          .exists()
          .catch(() => false),
        binaryPath: safeBinary(cfg.realBinaryName),
      })),
    );
    return c.json({
      ok: true as const,
      version: pkg.version,
      uptimeS: Math.round((Date.now() - deps.startedAt) / 1000),
      home: homedir(),
      aisHome: aisHome(),
      tools,
    });
  });

  app.get("/api/processes", (c) => scanProcesses().then((p) => c.json(p)));

  /* ------------------------------- identities ------------------------------ */

  app.get("/api/identities", async (c) => c.json(await listRegistries()));
  app.post("/api/identities/:tool", async (c) => c.json(await createIdentityInRegistry(c.req.param("tool"), await c.req.json())));
  app.patch("/api/identities/:tool/:name", async (c) =>
    c.json(await updateIdentityInRegistry(c.req.param("tool"), decodeSegment(c.req.param("name")), await c.req.json())),
  );
  app.delete("/api/identities/:tool/:name", async (c) =>
    c.json(await deleteIdentityFromRegistry(c.req.param("tool"), decodeSegment(c.req.param("name")))),
  );

  for (const method of ["post", "delete"] as const) {
    app[method]("/api/identities/:tool/:name/directories", async (c) => {
      const body = await c.req.json();
      return c.json(
        await mutateDirectory(c.req.param("tool"), decodeSegment(c.req.param("name")), requireString(body.pattern, "pattern"), method === "post"),
      );
    });
    app[method]("/api/identities/:tool/:name/aliases", async (c) => {
      const body = await c.req.json();
      return c.json(
        await mutateAlias(c.req.param("tool"), decodeSegment(c.req.param("name")), requireString(body.alias, "alias"), method === "post"),
      );
    });
  }

  /* ---------------------------- limits / usage ----------------------------- */
  // Heavy scans run on worker threads (see workers.ts): a stalled scan must
  // never take the HTTP loop down with it.

  app.get("/api/limits", async (c) => {
    const result = await runScanIsolated("limits", {
      ...(queryValue(c, "tool") ? { tool: queryValue(c, "tool") } : {}),
      ...(queryValue(c, "identity") ? { identity: queryValue(c, "identity") } : {}),
      maxAgeS: numberQuery(c, "maxAge", 45),
    }, 45_000);
    if (!result.ok) throw new HttpError(result.status ?? 500, result.error ?? "limits scan failed");
    return c.json(result.payload);
  });
  app.get("/api/usage", async (c) => {
    const result = await runScanIsolated("usage", {
      ...(queryValue(c, "tool") ? { tool: queryValue(c, "tool") } : {}),
      ...(queryValue(c, "identity") ? { identity: queryValue(c, "identity") } : {}),
    }, 60_000);
    if (!result.ok) throw new HttpError(result.status ?? 500, result.error ?? "usage scan failed");
    return c.json(result.payload);
  });

  /* -------------------------------- sessions ------------------------------- */

  app.get("/api/sessions", async (c) => {
    const result = await runScanIsolated("sessions", {
      cwd: queryValue(c, "cwd"),
      ...(queryValue(c, "tool") ? { tool: queryValue(c, "tool") } : {}),
      ...(queryValue(c, "identity") ? { identity: queryValue(c, "identity") } : {}),
    }, 30_000);
    if (!result.ok) throw new HttpError(result.status ?? 500, result.error ?? "session scan failed");
    return c.json(result.payload);
  });

  /* ---------------------------------- auth --------------------------------- */

  app.get("/api/auth", async (c) => c.json(await authApi.authStatus()));

  app.post("/api/auth/zai-key", async (c) => {
    const body = await c.req.json();
    const tool = requireOneOf(body.tool, ["zai", "ali"] as const, "tool");
    return c.json(await authApi.writeProviderKey(tool, requireString(body.identity, "identity"), String(body.apiKey ?? "")));
  });

  app.post("/api/auth/ali-cookie", async (c) => {
    const body = await c.req.json();
    return c.json(await authApi.writeAliConsoleCookie(requireString(body.identity, "identity"), String(body.cookie ?? "")));
  });

  app.post("/api/auth/kimi-refresh", async (c) => {
    const body = await c.req.json();
    return c.json(await authApi.refreshKimiToken(requireString(body.identity, "identity")));
  });

  app.post("/api/auth/login", async (c) => {
    const body = await c.req.json();    const toolName = requireString(body.tool, "tool");
    if (!(toolName in TOOL_CONFIGS)) throw new HttpError(404, `unknown tool "${toolName}"`);
    return c.json(await authApi.spawnLogin(toolName as ToolConfig["toolName"], requireString(body.identity, "identity")));
  });

  /* ----------------------- credential refresh scheduler -------------------- */

  app.get("/api/auth/refresh", (c) => c.json({ results: deps.authRefresh?.status() ?? [] }));

  app.post("/api/auth/refresh", async (c) => {
    if (!deps.authRefresh) return c.json({ error: "refresh scheduler not running" }, 503);
    const body = await c.req.json();
    const tool = requireString(body.tool, "tool");
    const ok = await deps.authRefresh.refreshNow(tool, requireString(body.identity, "identity"));
    const status = deps.authRefresh.status().find((entry) => entry.tool === tool && entry.identity === body.identity);
    return c.json({ ok, status });
  });

  /* ---------------------------------- files -------------------------------- */

  app.get("/api/files/roots", async (c) => c.json({ roots: await filesApi.listRoots() }));

  app.get("/api/files/tree", async (c) => {
    const root = requireString(queryValue(c, "root") ?? "", "root");
    return c.json(await filesApi.tree(root, queryValue(c, "path")));
  });

  app.get("/api/files/file", async (c) => {
    const root = requireString(queryValue(c, "root") ?? "", "root");
    const path = requireString(queryValue(c, "path"), "path");
    return c.json(await filesApi.readTextFile(root, path));
  });

  app.put("/api/files/file", async (c) => {
    const body = await c.req.json();
    const root = requireString(body.root, "root");
    const path = requireString(body.path, "path");
    const content = typeof body.content === "string" ? body.content : "";
    return c.json(await filesApi.writeTextFile(root, path, content));
  });

  app.post("/api/files/backup", async (c) => {
    const repoPath = await runBackup();
    return c.json({ ok: true, repoPath });
  });

  /* ------------------------- static WebUI (apps/web) ----------------------- */

  mountStatic(app, deps.distDir);

  return app;
}

/** Serves the built WebUI when dist exists. Hand-rolled rather than
 * hono/bun's serveStatic so behaviour is identical regardless of cwd: any
 * non-/api GET maps to a file inside distDir (path-normalised, escapes
 * rejected), falling back to index.html for SPA deep links. */
function mountStatic(app: Hono, distDir: string | undefined): void {
  if (!distDir) return;
  const distReal = resolve(distDir);

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };

  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/")) return c.notFound();
    const rel = url.pathname.replace(/^\/+/, "");
    let filePath = normalize(join(distReal, rel));
    if (!filePath.startsWith(distReal)) return c.notFound();
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, "index.html");
      return c.body(Bun.file(filePath).stream(), 200, {
        "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      });
    } catch {
      // SPA deep link: fall back to the shell.
      const index = join(distReal, "index.html");
      return c.body(Bun.file(index).stream(), 200, { "Content-Type": MIME[".html"] });
    }
  });
}

function safeBinary(name: ToolConfig["realBinaryName"] | string): string | null {
  try {
    const found = Bun.which(name) ?? resolveRealBinary(name as never);
    return found || null;
  } catch {
    return null;
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `"${field}" is required`);
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const str = requireString(value, field);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new HttpError(400, `"${field}" must be one of: ${allowed.join(", ")}`);
  }
  return str as T;
}

function queryValue(c: { req: { query(name: string): string | undefined } }, name: string): string | undefined {
  const value = c.req.query(name);
  return value === undefined || value === "" ? undefined : value;
}

function numberQuery(c: { req: { query(name: string): string | undefined } }, name: string, fallback: number): number {
  const raw = queryValue(c, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Re-exported for serve.ts/tests that want to probe the dist dir without
// duplicating the stat dance.
export async function distDirExists(path: string): Promise<boolean> {
  try {
    return (await stat(resolve(path))).isDirectory();
  } catch {
    return false;
  }
}
