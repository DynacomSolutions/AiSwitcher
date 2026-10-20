import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ais-qmp-tests-"));
const qmpServer = `
import json, socket, sys
path, ready, event_json, before_reply, close_without_event, sessions = sys.argv[1:]
events = json.loads(event_json)
if not isinstance(events, list): events = [events]
for index in range(int(sessions)):
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
    open(ready, "w").close()
    connection, _ = server.accept()
    stream = connection.makefile("rwb", buffering=0)
    stream.write(b'{"QMP":{"version":{},"capabilities":[]}}\\r\\n')
    while True:
        line = stream.readline()
        if not line:
            break
        command = json.loads(line)
        if command.get("execute") == "qmp_capabilities":
            stream.write(json.dumps({"return": {}, "id": command["id"]}).encode() + b"\\r\\n")
        elif command.get("execute") == "cont":
            if close_without_event == "yes":
                connection.close()
                break
            event = events[index]
            if before_reply == "yes":
                stream.write(json.dumps(event).encode() + b"\\r\\n")
            stream.write(json.dumps({"return": {}, "id": command["id"]}).encode() + b"\\r\\n")
            if before_reply != "yes":
                stream.write(json.dumps(event).encode() + b"\\r\\n")
            break
    stream.close()
    connection.close()
    server.close()
    if index + 1 < int(sessions): __import__("os").unlink(path)
`;
writeFileSync(join(scratch, "qmp-server.py"), qmpServer);
let sequence = 0;

async function scenario(event: unknown, options: { beforeContinueReply?: boolean; closeWithoutEvent?: boolean; expectedBoots?: number } = {}) {
  const directory = join(scratch, `case-${sequence++}`);
  mkdirSync(directory);
  const ready = join(directory, "ready");
  const evidence = join(directory, "shutdown.json");
  const server = Bun.spawn([
    "python3", join(scratch, "qmp-server.py"), "qmp.sock", ready, JSON.stringify(event ?? null),
    options.beforeContinueReply ? "yes" : "no", options.closeWithoutEvent ? "yes" : "no", String(options.expectedBoots ?? 1),
  ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const serverOut = new Response(server.stdout).text();
  const serverErr = new Response(server.stderr).text();
  const readyDeadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < readyDeadline) await Bun.sleep(10);
  if (!existsSync(ready)) {
    server.kill();
    await server.exited;
    throw new Error("QMP fixture server failed to start");
  }

  const watcher = Bun.spawn([
    "python3", join(process.cwd(), "image/test/qmp-watch.py"), "qmp.sock", evidence,
    String(options.expectedBoots ?? 1),
  ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const watcherOut = new Response(watcher.stdout).text();
  const watcherErr = new Response(watcher.stderr).text();
  const timeout = setTimeout(() => {
    watcher.kill();
    server.kill();
  }, 10_000);
  let watcherStatus: number;
  let serverStatus: number;
  let stdout: string;
  let stderr: string;
  let fixtureOut: string;
  let fixtureErr: string;
  try {
    [watcherStatus, serverStatus, stdout, stderr, fixtureOut, fixtureErr] = await Promise.all([
      watcher.exited, server.exited, watcherOut, watcherErr, serverOut, serverErr,
    ]);
  } finally {
    clearTimeout(timeout);
    if (watcher.exitCode === null) watcher.kill();
    if (server.exitCode === null) server.kill();
  }
  if (serverStatus !== 0) throw new Error(`QMP fixture failed: ${fixtureOut} ${fixtureErr}`);
  return {
    status: watcherStatus, stdout, stderr, evidence: existsSync(evidence),
    boots: existsSync(evidence) ? JSON.parse(readFileSync(evidence, "utf8")).boots.length : 0,
  };
}

describe.skipIf(!Bun.which("python3"))("QMP shutdown evidence", () => {
  test("negotiates and accepts guest-shutdown, retaining events before cont reply", async () => {
    const result = await scenario({ event: "SHUTDOWN", data: { guest: true, reason: "guest-shutdown" } }, { beforeContinueReply: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("QMP confirmed guest-shutdown");
    expect(result.evidence).toBe(true);
  });

  test("reconnects and records clean shutdown evidence for every boot", async () => {
    const shutdown = { event: "SHUTDOWN", data: { guest: true, reason: "guest-shutdown" } };
    const result = await scenario([shutdown, shutdown], { expectedBoots: 2 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("boot=1");
    expect(result.stdout).toContain("boot=2");
    expect(result.boots).toBe(2);
  });

  test.each([
    ["guest reset", { guest: true, reason: "guest-reset" }],
    ["host signal", { guest: false, reason: "host-signal" }],
    ["host QMP quit", { guest: false, reason: "host-qmp-quit" }],
    ["missing reason", { guest: true }],
    ["missing guest confirmation", { reason: "guest-shutdown" }],
  ])("rejects %s shutdown evidence", async (_name, data) => {
    const result = await scenario({ event: "SHUTDOWN", data });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-clean shutdown");
    expect(result.evidence).toBe(true);
  });

  test("rejects QMP disconnect without shutdown evidence", async () => {
    const result = await scenario(undefined, { closeWithoutEvent: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("connection closed without shutdown evidence");
    expect(result.evidence).toBe(false);
  });

  test.each([false, true])("rejects guest reset events after negotiation (cont early=%s)", async (beforeReply) => {
    const result = await scenario({ event: "RESET", data: {} }, { beforeContinueReply: beforeReply });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reported RESET");
  });
});

describe("reboot-after-ack scenario driver", () => {
  const directory = join(scratch, "reboot-driver");
  const script = join(directory, "reboot-after-ack.sh");
  const image = join(directory, "fixture.img");
  const calls = join(directory, "calls.log");
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(process.cwd(), "image/test/reboot-after-ack.sh"), script);
  writeFileSync(image, "SYNTHETIC_FIXTURE\n");
  writeFileSync(join(directory, "run-qemu.sh"), `#!/usr/bin/env bash
printf '%s\\n' "$2" >> "$AIS_SCENARIO_CALLS"
case $AIS_SCENARIO_STUB in
  reset) printf '%s\\n' '{"reason": "guest-reset"}' >&2; exit 1 ;;
  success) exit 0 ;;
  other) printf '%s\\n' '{"reason": "host-signal"}' >&2; exit 1 ;;
esac
`, { mode: 0o755 });

  function run(mode: string) {
    writeFileSync(calls, "");
    return Bun.spawnSync(["bash", script, image], {
      env: { ...process.env, AIS_SCENARIO_CALLS: calls, AIS_SCENARIO_STUB: mode },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("runs both firmware variants and accepts only guest-reset evidence", () => {
    const result = run("reset");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["bios", "uefi"]);
  });

  test.each([["success", "incorrectly passed clean shutdown"], ["other", "without guest-reset evidence"]])("rejects %s from either firmware", (mode, reason) => {
    const result = run(mode);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(reason);
  });
});
