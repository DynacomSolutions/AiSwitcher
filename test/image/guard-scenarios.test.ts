import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const qmp = resolve(root, "image/test/guard-qmp.py");
const guest = resolve(root, "image/test/guard-scenarios.sh");
const expectDriver = resolve(root, "image/test/guard.exp");
const expectTest = resolve(root, "image/test/guard-expect.test.exp");
const policy = resolve(root, "image/lib/ais_guard_policy.py");

describe("live guard scenario fixtures", () => {
  test("QMP mapper emits only supported printable keys and Enter", async () => {
    const proc = Bun.spawn(["python3", "-B", qmp, "--map-text", "Install synthetic-fixture"], { stdout: "pipe" });
    const result = await proc.exited;
    expect(result).toBe(0);
    const keys = JSON.parse(await new Response(proc.stdout).text()) as string[][];
    expect(keys).toContainEqual(["s"]);
    expect(keys).toContainEqual(["shift", "i"]);
    expect(keys).toContainEqual(["minus"]);
    expect(keys).toContainEqual(["spc"]);
    const rejected = Bun.spawnSync(["python3", "-B", qmp, "--map-text", "x; reboot"]);
    expect(rejected.exitCode).toBe(1);
    const newline = Bun.spawnSync(["python3", "-B", qmp, "--map-text", "vdb\n"]);
    expect(newline.exitCode).toBe(0);
    expect(newline.stdout.toString()).toContain('["ret"]');
  });

  test("guest entrypoint fails closed before any scratch disk writes", () => {
    const result = Bun.spawnSync(["bash", guest]);
    expect(result.exitCode).toBe(2);
    const source = readFileSync(guest, "utf8");
    expect(source).toContain("ais\\.test=1");
    expect(source).toContain("[[ -b /dev/vdb && -b /dev/vdc ]]");
    expect(source).toContain('runuser -u agent -- env -i');
  });

  test("driver supports the scenario's whitelisted keys and fails without QMP", () => {
    const source = readFileSync(expectDriver, "utf8");
    expect(source).toContain("wrong-target");
    const scenario = readFileSync(guest, "utf8");
    expect(scenario).toContain("herdr pane read --source recent --lines 80 --format text");
    expect(scenario).toContain("sleep 1.1");
    expect(scenario).toContain("status=prompt reply=%s");
    expect(source).toContain('elseif {$status eq "prompt"}');
    expect(source).toContain("reply arrived before rendered prompt");
    expect(source).toContain("prompt arrived before popup");
    expect(source).toContain("wrong-target");
    expect(source).toContain("QMP socket unavailable");
    expect(source).toContain("proc guard_expect_run {serial_id qmp_socket timeout_sec}");
    expect(source).toContain("set guard_interactive_scenarios {unanswered-dd destructive-tool raw-read-refusal wrong-target right-target symlink-swap aur-install}");
    expect(source).toContain("unexpected popup scenario $scenario");
    expect(source).toContain('if {$scenario ne "aur-install"}');
    expect(source).toContain("set prompt_replies [dict create]");
    expect(source).not.toContain("set guard_prompt_replies");
    const fullDriver = readFileSync(resolve(root, "image/test/guard-driver.exp"), "utf8");
    expect(source).toContain("guard orchestrator failed with $expect_out(1,string)");
    expect(fullDriver).toContain("case=run status=ok\\r*\\n");
    expect(fullDriver).toContain("case=([a-z-]+) status=reply\\r*\\n");
    expect(source).not.toContain("herdr plugin pane send-keys");
    expect(source).not.toContain("herdr plugin pane send-text");
  });

  test("Herdr denial checks use the v0.9.3 positional CLI and explain unexpected errors", () => {
    const scenario = readFileSync(guest, "utf8");
    expect(scenario).toContain('herdr pane "$operation" "$pane" x 2>&1');
    expect(scenario).toContain("Herdr pane %s failed without a permission-denial response");
    expect(scenario).toContain('herdr api snapshot 2>&1');
    expect(scenario).toContain("$output != *'permission denied'*");
    expect(scenario).toContain("Herdr API snapshot failed without a permission-denial response");
    expect(scenario).toContain('herdr pane "$operation" "$pane" x 2>&1');
  });

  test("synthetic makepkg fixtures do not require debugedit", () => {
    for (const fixture of [
      "image/test/fixtures/guard-repo/synthetic-repo-probe/PKGBUILD",
      "image/test/fixtures/guard-aur/synthetic-fixture/PKGBUILD",
    ]) {
      expect(readFileSync(resolve(root, fixture), "utf8")).toContain("options=('!debug')");
    }
  });

  test("guard driver requires completed orchestration and every requested sandbox probe", () => {
    const driver = readFileSync(resolve(root, "image/test/guard-driver.exp"), "utf8");
    const scenario = readFileSync(resolve(root, "image/test/run-scenario.sh"), "utf8");
    expect(scenario).toContain("if [[ $arg == probe ]]; then export AIS_GUARD_PROBE_EXPECTED=1");
    expect(driver).toContain("set expect_probe [expr {[info exists env(AIS_GUARD_PROBE_EXPECTED)]");
    expect(driver).toContain("sandbox-probe status=complete\\r*\\n");
    expect(driver).toContain("mdadm-create|mdadm-stop|luks-format|luks-open|luks-close");
    expect(driver).toContain("case=probe status=ok\\r*\\n");
    expect(driver).toContain("orchestrator completed before requested sandbox probe succeeded");
    expect(driver).toContain("serial stream closed before orchestrator completion");
  });

  test("guard QMP uses a short path relative to the runner's working directory", () => {
    const driver = readFileSync(resolve(root, "image/test/guard-driver.exp"), "utf8");
    const runner = readFileSync(resolve(root, "image/test/run-qemu.sh"), "utf8");
    expect(driver).toContain("set qmp guard.qmp");
    expect(driver).toContain("guard_expect_run $spawn_id $qmp $boot_timeout");
    expect(driver).toContain("set timeout $boot_timeout");
    expect(driver).not.toMatch(/guard_expect_run \$spawn_id \$qmp 600|set timeout 900/);
    expect(driver).not.toContain("file join $env(AIS_QEMU_RUN_DIR)");
    expect(runner).toContain('cd -- "$work"');
    expect(runner).toContain('expect "$driver"');
    expect(runner.indexOf('cd -- "$work"')).toBeLessThan(runner.indexOf('expect "$driver"'));
  });

  const expectBin = process.env.AIS_TEST_EXPECT_BIN ?? "expect";
  const hasExpect = process.env.CI === "true" || Bun.which(expectBin) !== null;
  // Outside CI a missing host tool skips (reason: `expect` not on PATH); in CI it must run and fail loudly.
  (hasExpect ? test : test.skip)("Expect driver handles reply, no-reply, deferred, missing and unexpected cases", async () => {
    const scratch = process.env.AIS_TEST_SCRATCH_DIR ?? tmpdir();
    mkdirSync(scratch, { recursive: true });
    const env = { ...process.env, AIS_GUARD_TEST_SCRATCH: scratch };
    const proc = Bun.spawn([expectBin, expectTest, expectDriver], { env, stdout: "pipe", stderr: "pipe" });
    const status = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("guard Expect driver tests passed");
  });

  test("QMP client frames fragmented responses and sends shifted keys as chords", async () => {
    const socket = `q${process.pid}.sock`;
    const server = createServer((connection) => {
      connection.write('{"QMP":{');
      setTimeout(() => connection.write('"version":{}}}\r\n'), 2);
      let input = "";
      let sentCaps = false;
      connection.on("data", (chunk) => {
        input += chunk.toString();
        while (input.includes("\r\n")) {
          const [line, rest] = input.split("\r\n", 2);
          input = rest;
          const request = JSON.parse(line) as { execute: string; arguments?: { keys: Array<{ data: string }> } };
          if (request.execute === "qmp_capabilities" && !sentCaps) {
            sentCaps = true;
            connection.write('{"return":{}}\r\n');
          } else if (request.execute === "send-key") {
            expect(request.arguments?.keys.map((item) => item.data)).toEqual(["shift", "i"]);
            connection.write('{"event":"TEST"}\r\n{"return":{}}\r\n');
            connection.end();
          }
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
    try {
      const proc = Bun.spawn(["python3", "-B", qmp, "--socket", socket, "--text", "I"], { stderr: "pipe" });
      const result = await proc.exited;
      expect(result).toBe(0);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(socket, { force: true }); // server.close() usually removes it already
    }
  });

  test("all required scenario families are named", () => {
    const source = readFileSync(guest, "utf8");
    for (const scenario of [
      "unanswered-dd-refusal", "typed-target-write", "absolute-path-denial",
      "destructive-tools-refuse", "read-only-commands", "sudo-refusal",
      "pacman-and-aur-gate", "raw-read-refusal", "pacman-dangerous-flags",
      "symlink-swap", "tiocsti-denial", "pane-api-denial", "herdr-socket-denial",
    ]) expect(source).toContain(scenario);
  });

  test("canonical device approval identity survives a later alias swap", () => {
    const script = `import importlib.util, os, stat, sys
spec=importlib.util.spec_from_file_location("policy",sys.argv[1]); policy=importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
alias="/dev/ais-guard-synthetic-link"; canonical="/dev/vdb"
realpath=os.path.realpath; original_stat=os.stat; swapped=[False]
def fake_realpath(path): return "/dev/vdc" if swapped[0] and path==alias else canonical if path==alias else realpath(path)
def fake_stat(path,*args,**kwargs):
 if path in ("/dev/vdb","/dev/vdc"):
  from types import SimpleNamespace
  return SimpleNamespace(st_mode=stat.S_IFBLK|0o600,st_rdev=77 if path=="/dev/vdb" else 88)
 return original_stat(path,*args,**kwargs)
os.path.realpath=fake_realpath; os.stat=fake_stat
argv,devices=policy.resolve_devices("dd",["if=/dev/zero","of="+alias,"bs=1","seek=4096"],"/")
assert argv[1]=="of=/dev/vdb" and devices[0][1]=="/dev/vdb"
approved_rdev=devices[0][2]; swapped[0]=True
assert os.stat(devices[0][1]).st_rdev==approved_rdev
print("canonical approval identity retained")`;
    const result = Bun.spawnSync(["python3", "-B", "-c", script, policy]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("canonical approval identity retained");
  });
});
