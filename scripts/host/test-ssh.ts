import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requestHost } from "../../src/host/remote.ts";
import { parseBundleTar } from "../../src/live/bundle.ts";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = process.env.HOST_TEST_SCRATCH ?? process.env.TMPDIR ?? tmpdir();
const scratch = join(scratchRoot, "ais-host-ssh-integration", randomUUID());
const sshd = Bun.which("sshd");
const ssh = Bun.which("ssh");
const clientKey = process.env.HOST_TEST_CLIENT_KEY;
const hostKey = process.env.HOST_TEST_HOST_KEY;
if (!sshd || !ssh) throw new Error("sshd and ssh are required for the isolated SSH contract test");
if (!clientKey || !hostKey) throw new Error("set HOST_TEST_CLIENT_KEY and HOST_TEST_HOST_KEY to existing synthetic key files");
if ([clientKey, hostKey].some((path) => resolve(path).startsWith(`${root}/`))) throw new Error("synthetic SSH keys must remain outside the checkout");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, kill: () => void): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) { kill(); throw new Error("isolated SSH helper output exceeded its cap"); }
    size += value.byteLength;
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
async function command(executable: string, args: string[], timeoutMs = 10_000): Promise<{ status: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => { try { child.kill(); } catch { /* completed */ } }, timeoutMs);
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, readCapped(child.stdout, 4096, () => child.kill()), readCapped(child.stderr, 4096, () => child.kill())]);
    return { status, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
  } finally { clearTimeout(timeout); }
}
async function reservePort(): Promise<number> {
  const server = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}
async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "localhost", port });
    const timer = setTimeout(() => socket.destroy(), 250);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
    socket.once("close", () => { clearTimeout(timer); resolve(false); });
  });
}
async function waitForServer(port: number, child: ReturnType<typeof Bun.spawn>, diagnostic: () => string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error("isolated sshd exited before accepting connections");
    if (await portAcceptsConnections(port)) return;
    await Bun.sleep(100);
  }
  throw new Error(`isolated sshd did not accept a loopback connection: ${diagnostic().slice(0, 256)}`);
}

await mkdir(scratch, { recursive: true, mode: 0o700 });
const remoteHome = join(scratch, "remote home; SYNTHETIC_FIXTURE $(false)");
const keyPath = resolve(clientKey);
const hostKeyPath = resolve(hostKey);
const authorizedKeysPath = join(scratch, "authorized_keys");
const knownHostsPath = join(scratch, "known_hosts");
const badKnownHostsPath = join(scratch, "known_hosts_wrong_key");
const sshConfigPath = join(scratch, "ssh_config");
const badSshConfigPath = join(scratch, "ssh_config_wrong_key");
const syncConfigPath = join(scratch, "sync-v2.json");
const forcedCommandPath = join(scratch, "forced-command.sh");
const daemonConfigPath = join(scratch, "sshd_config");
await mkdir(join(remoteHome, ".claude/projects/SYNTHETIC_FIXTURE_session"), { recursive: true, mode: 0o700 });
await writeFile(join(remoteHome, ".claude/projects/SYNTHETIC_FIXTURE_session/session.jsonl"), '{"event":"SYNTHETIC_FIXTURE_remote_log"}\n', { mode: 0o600 });
const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
const hostPublic = (await readFile(`${hostKeyPath}.pub`, "utf8")).trim().split(/\s+/);
assert(publicKey.includes("SYNTHETIC_FIXTURE") && hostPublic.join(" ").includes("SYNTHETIC_FIXTURE"), "supplied SSH public keys must carry a SYNTHETIC_FIXTURE marker");
const clientPublic = publicKey.split(/\s+/);
assert(clientPublic[1] !== hostPublic[1], "synthetic client and host keys must be distinct");
await writeFile(authorizedKeysPath, `${publicKey}\n`, { mode: 0o600 });
await writeFile(forcedCommandPath, `#!/bin/sh\nif [ "$SSH_ORIGINAL_COMMAND" != "ais host --stdio" ]; then exit 126; fi\n# shellcheck disable=SC2016 # The single-quoted synthetic HOME intentionally contains literal shell syntax.\nexport HOME=${quoteShell(remoteHome)}\nexec bun run ${quoteShell(join(root, "src/ais.ts"))} host --stdio\n`, { mode: 0o700 });
const port = await reservePort();
const daemonConfig = [
  `Port ${port}`, "ListenAddress localhost", `HostKey ${hostKeyPath}`, `PidFile ${join(scratch, "sshd.pid")}`,
  "UsePAM no", "StrictModes no", "PubkeyAuthentication yes", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
  "PermitRootLogin no", "AllowTcpForwarding no", "X11Forwarding no", `AuthorizedKeysFile ${authorizedKeysPath}`,
  `ForceCommand ${forcedCommandPath}`, "LogLevel QUIET", "",
].join("\n");
await writeFile(daemonConfigPath, daemonConfig, { mode: 0o600 });
await writeFile(knownHostsPath, `[localhost]:${port} ${hostPublic[0]} ${hostPublic[1]}\n`, { mode: 0o600 });
await writeFile(badKnownHostsPath, `[localhost]:${port} ${clientPublic[0]} ${clientPublic[1]}\n`, { mode: 0o600 });
const baseConfig = (known: string) => [
  "Host SYNTHETIC_FIXTURE_host", "  HostName localhost", `  Port ${port}`, `  User ${Bun.env.USER ?? "nobody"}`,
  `  IdentityFile ${keyPath}`, "  IdentitiesOnly yes", `  UserKnownHostsFile ${known}`, "  StrictHostKeyChecking yes", "",
].join("\n");
await writeFile(sshConfigPath, baseConfig(knownHostsPath), { mode: 0o600 });
await writeFile(badSshConfigPath, baseConfig(badKnownHostsPath), { mode: 0o600 });
await writeFile(syncConfigPath, JSON.stringify({ version: 2, remotes: ["SYNTHETIC_FIXTURE_host"] }), { mode: 0o600 });
let serverError = "";
const server = Bun.spawn([sshd, "-D", "-e", "-f", daemonConfigPath], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
void readCapped(server.stderr, 2048, () => server.kill()).then((bytes) => { serverError = new TextDecoder().decode(bytes); }).catch(() => {});
const previousSyncConfig = process.env.AIS_SYNC_CONFIG;
process.env.AIS_SYNC_CONFIG = syncConfigPath;
try {
  await waitForServer(port, server, () => serverError);
  const withConfig = (config: string) => (argv: string[], options: { stdin: "pipe"; stdout: "pipe"; stderr: "ignore"; signal?: AbortSignal }) => Bun.spawn([ssh, "-F", config, ...argv.slice(1)], options);
  const result = await requestHost({ kind: "ssh", alias: "SYNTHETIC_FIXTURE_host" }, { operation: "exportSnapshot" }, withConfig(sshConfigPath));
  assert(result.header.ok && result.payload.byteLength > 0, "SSH adapter did not return a framed snapshot");
  const bundle = parseBundleTar(result.payload, "inbox");
  assert(bundle.files.has(".claude/projects/SYNTHETIC_FIXTURE_session/session.jsonl"), "SSH snapshot omitted the synthetic remote log record");
  let rejectedWrongHostKey = false;
  try {
    await requestHost({ kind: "ssh", alias: "SYNTHETIC_FIXTURE_host" }, { operation: "capabilities" }, withConfig(badSshConfigPath));
  } catch { rejectedWrongHostKey = true; }
  assert(rejectedWrongHostKey, "SSH adapter accepted a host key that was not pinned in its isolated known_hosts file");
  console.log("Isolated SSH integration passed: strict pinned host key, batch authentication, fixed forced command, framed export, and wrong-host-key rejection.");
} finally {
  if (previousSyncConfig === undefined) delete process.env.AIS_SYNC_CONFIG;
  else process.env.AIS_SYNC_CONFIG = previousSyncConfig;
  try { server.kill(); } catch { /* already exited */ }
  await server.exited;
}
