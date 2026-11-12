/**
 * One gateway replica as its own process, for test/gateway/ha.test.ts. HOME is the replica's scratch home; every provider
 * call (token endpoint and API) goes to the test's fake provider at HA_FAKE_PROVIDER. Prints {"port","adminPort"} once.
 */
import { refreshIdentityOAuthGrant } from "../../../src/identities/oauth-refresh.ts";
import { parseStoreKey } from "../../../src/gateway/home-store.ts";
import { startGateway } from "../../../src/gateway/serve.ts";

const fake = process.env.HA_FAKE_PROVIDER!;
const redirect = (kind: "token" | "api"): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const target = kind === "token" ? `${fake}/token` : `${fake}/api${u.pathname}${u.search}`;
    if (input instanceof Request) return fetch(new Request(target, input));
    return fetch(target, init);
  }) as typeof fetch;

const g = await startGateway(
  {
    port: 0,
    adminPort: Number(process.env.HA_ADMIN_PORT),
    databaseUrl: process.env.HA_DATABASE_URL!,
    adminToken: process.env.HA_ADMIN_TOKEN!,
    handleSignals: true,
    credentialStore: { key: parseStoreKey(process.env.AIS_GATEWAY_STORE_KEY) },
    replicaUrl: `http://127.0.0.1:${process.env.HA_ADMIN_PORT}`,
  },
  {
    host: "127.0.0.1",
    fetch: redirect("api"),
    refreshImpl: (tool, identity, opts) => refreshIdentityOAuthGrant(tool, identity, { ...opts, fetchImpl: redirect("token") }),
    fetchUsage: async () => undefined,
    storePollMs: 500,
    leaderTryMs: 500,
    keepAliveMs: 1_000,
    pingMs: 500,
  },
);
console.log(JSON.stringify({ port: g.port, adminPort: g.adminPort }));
