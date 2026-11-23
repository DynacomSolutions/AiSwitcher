import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { t3Paths } from "../../identities/t3-anthropic-proxy.ts";
import { createFavouritesClient, type FavouritesApi } from "../../t3/favourites/client.ts";
import { ADMIN_TOKEN_KEY, ADMIN_URL_KEY, gatewayAdmin } from "../../t3/favourites/config.ts";
import { FavSyncMetrics } from "../../t3/favourites/metrics.ts";
import { homeKey, hostNames, metricsPathOf, runFavouritesSync, syncOnce, type HostNames } from "../../t3/favourites/sync.ts";

export interface T3CliDeps {
  out(line: string): void;
  /** Tests give a client; the command otherwise makes one from the gateway admin address and token. */
  client?: FavouritesApi;
  names?: () => Promise<HostNames>;
  env?: Record<string, string | undefined>;
  stateDir?: string;
  /** Tests stop the long-running mode through this signal. */
  signal?: AbortSignal;
}

const USAGE = "Usage: ais t3 favourites sync [--once] [--t3-home=<dir>] [--metrics-listen=<host:port>] [--interval=<seconds>]";

/** `ais t3 favourites sync`: keeps the model favourites of one T3 Code home in step with the AIS gateway list, in both directions. */
export async function runT3Command(positionals: string[], flags: ParsedArgs["flags"], deps: Partial<T3CliDeps> = {}): Promise<void> {
  const d: T3CliDeps = { out: (line) => console.info(line), ...deps };
  const [group, sub, ...extra] = positionals;
  if (group !== "favourites" || sub !== "sync" || extra.length > 0) throw new CliUsageError(USAGE);
  const env = d.env ?? process.env;
  const t3Home = stringFlag(flags, "t3-home") ?? t3Paths({ env }).t3Home;
  const interval = stringFlag(flags, "interval");
  const fallbackMs = interval === undefined ? undefined : Number(interval) * 1000;
  if (fallbackMs !== undefined && !(Number.isFinite(fallbackMs) && fallbackMs >= 1000)) throw new CliUsageError("--interval must be at least 1 second");
  const listen = stringFlag(flags, "metrics-listen");
  if (listen !== undefined && !/^[^:\s]+:\d{1,5}$/.test(listen)) throw new CliUsageError("--metrics-listen must be host:port");

  let client = d.client;
  if (!client) {
    const admin = await gatewayAdmin(env);
    if (!admin) throw new CliUsageError(`${ADMIN_URL_KEY} and ${ADMIN_TOKEN_KEY} must be set in the environment or in ~/.secrets`);
    client = createFavouritesClient(admin);
  }
  const metrics = new FavSyncMetrics(metricsPathOf(t3Home, d.stateDir));
  const sync = { t3Home, client, names: d.names ?? hostNames, metrics, ...(d.stateDir ? { stateDir: d.stateDir } : {}), log: (m: string) => console.error(`ais: ${m}`) };

  if (boolFlag(flags, "once")) {
    try {
      // A round that met a write of T3 Code itself runs again: three tries end any short burst.
      for (let i = 0; ; i++) {
        const r = await syncOnce(sync);
        if (r.status === "retry" && i < 2) continue;
        if (r.status === "no-settings") d.out(`t3 favourites sync: no settings.json in this T3 home (${homeKey(t3Home)})`);
        else if (r.status === "retry") throw new Error("T3 Code kept writing its settings; run it again");
        else d.out(`t3 favourites sync: ${r.pushed} sent to the gateway, T3 settings ${r.wrote ? "updated" : "unchanged"} (list version ${r.seq})`);
        return;
      }
    } catch (err) {
      metrics.s.errors += 1;
      throw err;
    } finally {
      metrics.persist();
    }
  }

  const ctl = new AbortController();
  const stop = (): void => ctl.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  d.signal?.addEventListener("abort", stop, { once: true });
  const server = listen
    ? Bun.serve({
        hostname: listen.slice(0, listen.lastIndexOf(":")),
        port: Number(listen.slice(listen.lastIndexOf(":") + 1)),
        fetch: (req) => (new URL(req.url).pathname === "/metrics" ? new Response(metrics.render(homeKey(t3Home)), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } }) : new Response("not found", { status: 404 })),
      })
    : undefined;
  try {
    d.out(`t3 favourites sync: following ${homeKey(t3Home)}`);
    await runFavouritesSync(sync, { signal: ctl.signal, ...(fallbackMs !== undefined ? { fallbackMs } : {}) });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await server?.stop(true);
  }
}
