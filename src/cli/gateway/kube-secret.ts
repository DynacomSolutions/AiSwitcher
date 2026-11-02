export interface KubectlResult {
  code: number;
  stderr: string;
}

/** Runs kubectl with the given argv and stdin text. Secrets travel through stdin only. */
export type KubectlRunner = (args: string[], stdin: string) => Promise<KubectlResult>;

export const runKubectl: KubectlRunner = async (args, stdin) => {
  const proc = Bun.spawn(["kubectl", ...args], { stdin: new TextEncoder().encode(stdin), stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr: stderr.trim() };
};

export const secretName = (app: string): string => `ais-gateway-${app}`;

/**
 * Applies Secret `ais-gateway-<app>` into `ns` with the caller's kube context. The manifest
 * (JSON, which is valid YAML) goes through stdin; the token never appears in argv.
 */
export async function writeAppSecret(
  ns: string,
  app: string,
  data: { url: string; username: string; token: string },
  kubectl: KubectlRunner = runKubectl,
): Promise<void> {
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: secretName(app), namespace: ns, labels: { "app.kubernetes.io/managed-by": "ais-gateway" } },
    stringData: { AIS_GATEWAY_URL: data.url, AIS_GATEWAY_USERNAME: data.username, AIS_GATEWAY_TOKEN: data.token },
  };
  const res = await kubectl(["apply", "-f", "-"], JSON.stringify(manifest));
  if (res.code !== 0) throw new Error(`kubectl apply of Secret ${secretName(app)} in ${ns} failed: ${res.stderr || `exit ${res.code}`}`);
}
