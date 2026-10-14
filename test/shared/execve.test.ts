import { describe, expect, test } from "bun:test";
import { buildChildEnv, execveReal } from "../../src/shared/exec.ts";
import { buildEnvp, buildExecBlock, tryExecve } from "../../src/shared/execve.ts";

const BASE = 0x7f0000010000n;

/** Reads a NUL-terminated string at a fake address back out of the block. */
function cstr(buffer: Uint8Array, addr: bigint): string {
  const start = Number(addr - BASE);
  return new TextDecoder().decode(buffer.subarray(start, buffer.indexOf(0, start)));
}

/** Follows a NULL-terminated pointer table starting at a fake address. */
function table(buffer: Uint8Array, addr: bigint): string[] {
  const view = new BigUint64Array(buffer.buffer, 0, buffer.length / 8);
  const out: string[] = [];
  for (let i = Number(addr - BASE) / 8; view[i] !== 0n; i++) out.push(cstr(buffer, view[i]!));
  return out;
}

describe("buildEnvp", () => {
  test("drops undefined values and unencodable keys, keeps empty values", () => {
    expect(buildEnvp({ A: "1", B: undefined, "C=D": "x", "": "y", E: "", F: "a=b" })).toEqual(["A=1", "E=", "F=a=b"]);
  });

  test("matches spawnReal's child environment, including the extra and re-entry variables", () => {
    process.env.CODEX_SESSION_LEAK = "strip-me";
    try {
      const env = buildChildEnv({ CODEX_HOME: "/example/home", AIS_SHIM_EXEC_CODEX: "/real/codex" });
      const envp = buildEnvp(env);
      expect(envp).toContain("CODEX_HOME=/example/home");
      expect(envp).toContain("AIS_SHIM_EXEC_CODEX=/real/codex");
      expect(envp.some((entry) => entry.startsWith("CODEX_SESSION_LEAK="))).toBe(false);
    } finally {
      delete process.env.CODEX_SESSION_LEAK;
    }
  });
});

describe("buildExecBlock", () => {
  test("lays out path, NULL-terminated argv and envp tables, and NUL-terminated strings", () => {
    const block = buildExecBlock("/bin/tool", ["tool", "--flag", "ünï cödé", ""], ["A=1", "B=two words"], () => BASE);
    expect(cstr(block.buffer, block.pathAddr)).toBe("/bin/tool");
    expect(table(block.buffer, block.argvAddr)).toEqual(["tool", "--flag", "ünï cödé", ""]);
    expect(table(block.buffer, block.envpAddr)).toEqual(["A=1", "B=two words"]);
    // Both tables end in a real NULL pointer, back to back.
    const view = new BigUint64Array(block.buffer.buffer, 0, 8);
    expect(view[4]).toBe(0n);
    expect(view[7]).toBe(0n);
    expect(block.argvAddr).toBe(BASE);
    expect(block.envpAddr).toBe(BASE + 8n * 5n);
  });

  test("handles empty argv/envp and pads past the GC-movable size", () => {
    const block = buildExecBlock("/bin/x", [], [], () => BASE);
    expect(table(block.buffer, block.argvAddr)).toEqual([]);
    expect(table(block.buffer, block.envpAddr)).toEqual([]);
    expect(block.buffer.length).toBeGreaterThan(1000);
  });

  test("rejects NUL bytes instead of silently truncating", () => {
    expect(() => buildExecBlock("/bin/x", ["a\0b"], [], () => BASE)).toThrow(/NUL/);
    expect(() => buildExecBlock("/bin/x", [], ["A=b\0c"], () => BASE)).toThrow(/NUL/);
  });
});

describe("tryExecve", () => {
  test("returns false (process untouched) for a missing or non-executable path", () => {
    expect(tryExecve("/nonexistent/tool", ["tool"], {})).toBe(false);
    expect(execveReal("/nonexistent/tool", [], {})).toBe(false);
    expect(tryExecve("/etc/hostname", ["x"], {})).toBe(false);
  });

  test.skipIf(process.platform !== "linux")("replaces a real process: arguments and env arrive intact", () => {
    const script = `
      import { tryExecve } from ${JSON.stringify(new URL("../../src/shared/execve.ts", import.meta.url).pathname)};
      tryExecve("/bin/sh", ["sh", "-c", 'echo "$0|$1|$X|$Y|' + process.pid + '|$$"', "zero", "arg one"], { X: "ex ex", Y: undefined });
      process.exit(99);
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "" } });
    expect(proc.exitCode).toBe(0);
    const [zero, arg1, x, y, before, after] = proc.stdout.toString().trim().split("|");
    expect(zero).toBe("zero");
    expect(arg1).toBe("arg one");
    expect(x).toBe("ex ex");
    expect(y).toBe(""); // undefined values are not exported
    expect(after).toBe(before); // same PID: image replaced, not forked
  });
});
