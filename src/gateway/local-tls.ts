import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { aisHome } from "../shared/ais-home.ts";

/**
 * TLS material for the local gateway's HTTPS listener. Codex 0.167 refuses a non-HTTPS ChatGPT backend, so the loopback
 * gateway also serves HTTPS on LOCAL_GATEWAY_HTTP_PORT + 1, with a leaf signed by a private AIS CA. Codex trusts it
 * through CODEX_CA_CERTIFICATE=<ca-bundle.pem> (that file replaces codex's system roots, so the bundle carries both).
 */

export const LOCAL_GATEWAY_HTTP_PORT = 47140;
export const LOCAL_TLS_DIR_NAME = "gateway-local-tls";
const CA_DAYS = 3650;
const LEAF_DAYS = 365;
const RENEW_WITHIN_MS = 30 * 24 * 3600_000;
const SYSTEM_ROOT_CANDIDATES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"];

/** The HTTPS port next to an HTTP port: AIS_GATEWAY_LOCAL_TLS_PORT, else http port + 1 (0 stays 0: ephemeral). */
export function localGatewayTlsPort(httpPort: number = Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_GATEWAY_HTTP_PORT, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIS_GATEWAY_LOCAL_TLS_PORT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return httpPort === 0 ? 0 : httpPort + 1;
}

export const localTlsDir = (home?: string): string => join(aisHome(home), LOCAL_TLS_DIR_NAME);
export const localTlsBundlePath = (home?: string): string => join(localTlsDir(home), "ca-bundle.pem");

export interface LocalTls {
  dir: string;
  caPath: string;
  certPath: string;
  keyPath: string;
  bundlePath: string;
  /** Leaf certificate PEM. */
  cert: string;
  /** Leaf private key PEM. */
  key: string;
}

export interface EnsureLocalTlsOptions {
  dir?: string;
  now?: () => number;
  /** Candidate system root bundles, first readable wins (tests). */
  systemRoots?: string[];
  /** Runs openssl (tests); resolves the exit code and stderr. */
  openssl?: (args: string[]) => Promise<{ code: number; err: string }>;
}

async function runOpenssl(args: string[]): Promise<{ code: number; err: string }> {
  const child = Bun.spawn(["openssl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, err };
}

const readText = (path: string): Promise<string | undefined> => readFile(path, "utf8").then((t) => t, () => undefined);

function parseCert(pem: string | undefined): X509Certificate | undefined {
  if (!pem) return undefined;
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
}

const stillGood = (c: X509Certificate, now: number): boolean => new Date(c.validTo).getTime() - now > RENEW_WITHIN_MS && new Date(c.validFrom).getTime() <= now;

function leafUsable(leaf: X509Certificate | undefined, ca: X509Certificate | undefined, now: number): boolean {
  if (!leaf || !ca || !stillGood(leaf, now) || !stillGood(ca, now)) return false;
  return leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && leaf.checkHost("localhost") !== undefined && leaf.checkIP("127.0.0.1") !== undefined;
}

async function systemRootsText(candidates: string[]): Promise<string> {
  for (const path of candidates) {
    const text = await readText(path);
    if (text?.includes("BEGIN CERTIFICATE")) return text.endsWith("\n") ? text : `${text}\n`;
  }
  return "";
}

/** Writes `text` with `mode` via a temp file and a rename, only when it differs. */
async function writeIfChanged(path: string, text: string, mode: number): Promise<void> {
  if ((await readText(path)) === text) {
    await chmod(path, mode);
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/**
 * Makes sure the CA, the loopback leaf and the trust bundle exist and are fresh; generates what is missing with openssl.
 * The CA lives 10 years, the leaf one year and is renewed 30 days ahead (a new CA renews the leaf). Directory 0700, private keys 0600.
 */
export async function ensureLocalTls(opts: EnsureLocalTlsOptions = {}): Promise<LocalTls> {
  const dir = opts.dir ?? localTlsDir();
  const now = (opts.now ?? Date.now)();
  const openssl = opts.openssl ?? runOpenssl;
  const paths = { caPath: join(dir, "ca.pem"), caKeyPath: join(dir, "ca.key"), certPath: join(dir, "cert.pem"), keyPath: join(dir, "key.pem"), bundlePath: join(dir, "ca-bundle.pem") };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  let caPem = await readText(paths.caPath);
  let ca = parseCert(caPem);
  const caOk = ca !== undefined && (await readText(paths.caKeyPath)) !== undefined && stillGood(ca, now) && ca.ca;
  let certPem = await readText(paths.certPath);
  let keyPem = await readText(paths.keyPath);
  if (!(caOk && keyPem && leafUsable(parseCert(certPem), ca, now))) {
    const work = await mkdtemp(join(dir, ".gen-"));
    try {
      const w = (n: string): string => join(work, n);
      const run = async (args: string[]): Promise<void> => {
        const r = await openssl(args);
        if (r.code !== 0) throw new Error(`openssl ${args[0]} failed: ${r.err.trim().split("\n").slice(-2).join(" ")}`);
      };
      let signCa = paths.caPath;
      let signCaKey = paths.caKeyPath;
      if (!caOk) {
        await run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", w("ca.key"), "-out", w("ca.pem"), "-days", String(CA_DAYS), "-subj", "/CN=AIS local gateway CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
        signCa = w("ca.pem");
        signCaKey = w("ca.key");
      }
      await run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", w("key.pem"), "-out", w("leaf.csr"), "-subj", "/CN=localhost"]);
      await writeFile(w("leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
      await run(["x509", "-req", "-in", w("leaf.csr"), "-CA", signCa, "-CAkey", signCaKey, "-CAcreateserial", "-CAserial", w("ca.srl"), "-out", w("cert.pem"), "-days", String(LEAF_DAYS), "-extfile", w("leaf.ext")]);
      if (!caOk) {
        await writeIfChanged(paths.caKeyPath, await readFile(w("ca.key"), "utf8"), 0o600);
        await writeIfChanged(paths.caPath, await readFile(w("ca.pem"), "utf8"), 0o644);
      }
      await writeIfChanged(paths.keyPath, await readFile(w("key.pem"), "utf8"), 0o600);
      await writeIfChanged(paths.certPath, await readFile(w("cert.pem"), "utf8"), 0o644);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    caPem = await readText(paths.caPath);
    ca = parseCert(caPem);
    certPem = await readText(paths.certPath);
    keyPem = await readText(paths.keyPath);
  }
  if (!caPem || !certPem || !keyPem) throw new Error("local gateway TLS material is incomplete");
  const bundle = `${await systemRootsText(opts.systemRoots ?? SYSTEM_ROOT_CANDIDATES)}${caPem.endsWith("\n") ? caPem : `${caPem}\n`}`;
  await writeIfChanged(paths.bundlePath, bundle, 0o644);
  return { dir, caPath: paths.caPath, certPath: paths.certPath, keyPath: paths.keyPath, bundlePath: paths.bundlePath, cert: certPem, key: keyPem };
}
