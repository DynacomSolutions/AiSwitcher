import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ais-boot-driver-"));
let sequence = 0;
function driver(body: string, timeoutSeconds = 5) {
  const fixture = join(scratch, `serial-${sequence++}.tcl`);
  writeFileSync(fixture, body);
  return Bun.spawnSync(["expect", "image/test/boot.exp", String(timeoutSeconds), "tclsh", fixture], { stdout: "pipe", stderr: "pipe" });
}
const ready = `puts "AIS-LIVE: stage=kernel-up status=ok"
puts "AIS-LIVE: stage=smoke-ready status=ok"
flush stdout
gets stdin line
if {$line ne "AIS-TEST-POWEROFF"} {exit 5}
puts "AIS-LIVE: stage=poweroff status=ok"
flush stdout
`;

describe.skipIf(!Bun.which("expect") || !Bun.which("tclsh"))("serial boot driver", () => {
  test("requires the handshake and a successful process exit", () => {
    const result = driver(ready + "exit 0\n");
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("clean poweroff verified");
  });
  test("rejects a failing QEMU exit after successful markers", () => {
    const result = driver(ready + "exit 7\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("QEMU failed:");
  });
  test("rejects early EOF and absent shutdown markers", () => {
    const early = driver('puts "AIS-LIVE: stage=kernel-up status=ok"\nexit 0\n');
    expect(early.exitCode).not.toBe(0);
    expect(early.stderr.toString()).toContain("unexpected EOF waiting for smoke-ready");
    const missing = driver(ready.replace('puts "AIS-LIVE: stage=poweroff status=ok"', "") + "exit 0\n");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("unexpected EOF waiting for poweroff");
  });
  test("rejects a guest failure, kernel panic and a marker embedded in prose", () => {
    for (const text of ["AIS-LIVE: stage=kernel-up status=fail", "Kernel panic", "SYNTHETIC_FIXTURE AIS-LIVE: stage=kernel-up status=ok"]) {
      expect(driver(`puts "${text}"\nexit 0\n`).exitCode).not.toBe(0);
    }
  });
  test("rejects a buffered failure before a success marker", () => {
    const result = driver(`puts "AIS-LIVE: stage=kernel-up status=fail\nAIS-LIVE: stage=kernel-up status=ok\nAIS-LIVE: stage=smoke-ready status=ok"
flush stdout
gets stdin line
puts "AIS-LIVE: stage=poweroff status=ok"
flush stdout
exit 0
`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("guest reported failure");
  });
  test("keeps failure and panic guards active after the poweroff acknowledgement", () => {
    for (const text of ["AIS-LIVE: stage=poweroff status=fail", "Kernel panic"]) {
      const result = driver(ready + `after 150
puts "${text}"
flush stdout
exit 0
`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/guest reported failure|guest failed after shutdown acknowledgement|guest failed to boot/);
    }
  });
  test("times out without a marker and reaps its direct child", () => {
    const result = driver("after 10000\n", 1);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("timeout waiting for kernel-up");
  }, 5000);
});
