import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const releaseWorkflow = readFileSync(join(root, ".github/workflows/release-live-image.yml"), "utf8");
const buildWorkflow = readFileSync(join(root, ".github/workflows/live-image.yml"), "utf8");
const releaseScript = readFileSync(join(root, "image/build/release-assets.sh"), "utf8");
const run = (args: string[], env: Record<string, string | undefined> = {}) =>
  Bun.spawnSync(args, { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

describe("live image release contract", () => {
  test("keeps both workflows hosted, pinned, least-privileged and unscheduled", () => {
    expect(releaseWorkflow).toMatch(/push:\s*\n\s+tags:\s*\n\s+- ['"]live-v\*['"]/);
    expect(releaseWorkflow).not.toMatch(/(?:pull_request|workflow_dispatch|branches):/);
    expect(releaseWorkflow).toMatch(/^permissions:\s*\n\s+contents: read$/m);
    expect(releaseWorkflow.match(/\bcontents: write\b/g)).toHaveLength(1);
    const publishJob = releaseWorkflow.match(/^  publish:\n([\s\S]*?)(?=^  [a-z-]+:|$(?![\s\S]))/m)?.[1] ?? "";
    expect(publishJob).toContain("permissions:\n      contents: write");
    expect(releaseWorkflow).not.toMatch(/^\s+secrets:\s/m);
    for (const workflow of [releaseWorkflow, buildWorkflow]) {
      expect(workflow).not.toMatch(/^\s*schedule:/m);
      expect(workflow.toLowerCase()).not.toContain("docker");
      expect([...workflow.matchAll(/^\s*runs-on:\s*(.+)$/gm)].length).toBeGreaterThan(0);
      for (const [, runner] of workflow.matchAll(/^\s*runs-on:\s*(.+)$/gm)) expect(runner.trim()).toBe("ubuntu-latest");
      const externalActions = workflow.split("\n").filter((entry) => /^\s*(?:- )?uses:\s/.test(entry) && !entry.includes("./.github/workflows/"));
      expect(externalActions.length).toBeGreaterThan(0);
      for (const line of externalActions) {
        expect(line).toMatch(/@[0-9a-f]{40}(?:\s+#\s+v\S+)?$/);
      }
    }
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/live-image.yml");
    expect(releaseWorkflow).toContain("release: true");
    expect(releaseWorkflow).toContain("--latest=false");
    expect(releaseWorkflow).toContain("--verify-tag");
    expect(releaseWorkflow).toContain("image/release/notes.md");
    expect(releaseWorkflow).toContain("git merge-base --is-ancestor");
    expect(releaseWorkflow).toContain("::notice::");
    expect(releaseWorkflow).toContain("MINISIGN_SECRET_KEY");
    expect(releaseWorkflow).toContain("MINISIGN_PASSWORD");
    expect(releaseWorkflow).toMatch(/SIGNING_KEY: \$\{\{ secrets\.MINISIGN_SECRET_KEY \}\}[\s\S]*?if \[\[ -n "\$SIGNING_KEY" \]\]; then enabled=true; else enabled=false; fi[\s\S]*?if \[\[ "\$enabled" == false \]\]; then echo '::notice::/);
    expect(releaseWorkflow).toMatch(/publish:\n[\s\S]*?if: \$\{\{ needs\.signing\.outputs\.enabled == 'true' \}\}/);
    expect(releaseWorkflow).toContain("sudo apt-get install -y --no-install-recommends minisign");
    expect(releaseWorkflow.indexOf("bash image/build/release-assets.sh")).toBeLessThan(releaseWorkflow.indexOf("gh release create"));
    expect(releaseWorkflow).toContain("needs: [image, signing]");
    expect(buildWorkflow).toContain("AIS_IMAGE_TEST_PACKAGES=${{ matrix.flavour == 'test' && '1' || '0' }}");
    expect(buildWorkflow).toContain("ais-live.img");
    expect(buildWorkflow).toContain("ais-live-production.img");
    expect(buildWorkflow).toContain("ais-live-${{ matrix.flavour == 'test' && 'image' || 'release-image' }}");
    expect(buildWorkflow).toContain("firmware: [bios, uefi]");
    expect(buildWorkflow).not.toContain("inputs.release != true");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("Secure Boot must be");
    expect(readFileSync(join(root, "image/release/notes.md"), "utf8")).toContain("Apache-2.0");
    expect(readFileSync(join(root, "image/release/notes.md"), "utf8")).toContain("https://github.com/herdrdev/herdr");
  });

  test("uses stdin for minisign password, private temporary key and verified signature", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ais-release-signing-SYNTHETIC_FIXTURE-"));
    try {
      const bin = join(scratch, "bin");
      const runnerTemp = join(scratch, "runner-temp");
      const output = join(scratch, "assets");
      mkdirSync(bin);
      mkdirSync(runnerTemp);
      const log = join(scratch, "minisign.log");
      const stub = join(bin, "minisign");
      writeFileSync(stub, `#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == -S ]]; then
  [[ $# == 7 && $2 == -s && $4 == -x && $6 == -m ]] || exit 41
  key=$3; sig=$5; sums=$7
  [[ -f $key && $(stat -c %a "$key") == 600 ]] || exit 42
  password=$(cat)
  [[ $password == SYNTHETIC_FIXTURE_PASSWORD ]] || exit 43
  [[ ! " $* " =~ SYNTHETIC_FIXTURE_PASSWORD ]] || exit 44
  printf 'key=%s\n' "$key" >> "$SYNTHETIC_FIXTURE_MINISIGN_LOG"
  printf 'signature args=%s\n' "$*" >> "$SYNTHETIC_FIXTURE_MINISIGN_LOG"
  printf 'SYNTHETIC_FIXTURE_SIGNATURE\n' > "$sig"
  exit 0
fi
if [[ $1 == -Vm ]]; then
  [[ $# == 4 && $3 == -p && $4 == image/release/minisign.pub ]] || exit 45
  [[ -s $2 && -s $2.minisig ]] || exit 46
  [[ \${SYNTHETIC_FIXTURE_VERIFY_FAIL:-0} != 1 ]] || exit 47
  exit 0
fi
exit 48
`, { mode: 0o755 });
      const source = join(scratch, "source.img");
      writeFileSync(source, "SYNTHETIC_FIXTURE image bytes\n");
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        MINISIGN_SECRET_KEY: "SYNTHETIC_FIXTURE_MINISIGN_SECRET_KEY",
        MINISIGN_PASSWORD: "SYNTHETIC_FIXTURE_PASSWORD",
        SYNTHETIC_FIXTURE_MINISIGN_LOG: log,
      };
      const signed = run(["bash", "image/build/release-assets.sh", source, output], env);
      expect(signed.exitCode).toBe(0);
      expect(readFileSync(join(output, "SHA256SUMS.minisig"), "utf8")).toBe("SYNTHETIC_FIXTURE_SIGNATURE\n");
      const keyPath = readFileSync(log, "utf8").match(/^key=(.+)$/m)?.[1];
      expect(keyPath).toContain(`${runnerTemp}/minisign-key.`);
      expect(existsSync(keyPath!)).toBe(false);
      expect(readdirSync(runnerTemp)).toEqual([]);

      const failedOutput = join(scratch, "failed-assets");
      const failed = run(["bash", "image/build/release-assets.sh", source, failedOutput], {
        ...env,
        SYNTHETIC_FIXTURE_VERIFY_FAIL: "1",
      });
      expect(failed.exitCode).not.toBe(0);
      expect(existsSync(join(failedOutput, "SHA256SUMS.minisig"))).toBe(true);
      expect(readdirSync(runnerTemp)).toEqual([]);
      expect(statSync(join(failedOutput, "SHA256SUMS.minisig")).isFile()).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("creates the exact SHA256 manifest without signing when no secret is present", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ais-release-"));
    try {
      const source = join(scratch, "source.img");
      const output = join(scratch, "assets");
      writeFileSync(source, "SYNTHETIC_FIXTURE image bytes\n");
      const built = run(["bash", "image/build/release-assets.sh", source, output], {
        MINISIGN_SECRET_KEY: "",
        MINISIGN_PASSWORD: "",
      });
      expect(built.exitCode).toBe(0);
      const sums = readFileSync(join(output, "SHA256SUMS"), "utf8");
      expect(sums).toMatch(/^[0-9a-f]{64}  ais-live\.img\n$/);
      const checked = Bun.spawnSync(["sha256sum", "-c", "SHA256SUMS"], { cwd: output, stdout: "pipe", stderr: "pipe" });
      expect(checked.exitCode).toBe(0);
      expect(readFileSync(join(output, "ais-live.img"), "utf8")).toBe("SYNTHETIC_FIXTURE image bytes\n");
      expect(existsSync(join(output, "SHA256SUMS.minisig"))).toBe(false);
      expect(releaseScript).toContain("if [[ -n ${MINISIGN_SECRET_KEY:-} ]]");
      expect(releaseScript).toContain("minisign -Vm");
      expect(releaseScript.indexOf("if [[ -n ${MINISIGN_SECRET_KEY:-} ]]"))
        .toBeLessThan(releaseScript.indexOf("image/release/minisign.pub"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("uses the same strict 2 GiB limit for assembly and release", () => {
    expect(readFileSync(join(root, "image/build/assemble.sh"), "utf8")).toContain("assert-image-size.sh");
    expect(readFileSync(join(root, "image/build/assert-image-size.sh"), "utf8")).toContain("2 * 1024 * 1024 * 1024");
    expect(run(["bash", "image/build/assert-image-size.sh", String(2 * 1024 ** 3)]).exitCode).not.toBe(0);
    expect(run(["bash", "image/build/assert-image-size.sh", String(2 * 1024 ** 3 - 1)]).exitCode).toBe(0);
  });

  test("rejects an oversized sparse release image before copying or signing", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ais-release-oversize-SYNTHETIC_FIXTURE-"));
    try {
      const source = join(scratch, "oversized.img");
      const output = join(scratch, "assets");
      writeFileSync(source, "SYNTHETIC_FIXTURE");
      truncateSync(source, 2 * 1024 ** 3);
      const rejected = run(["bash", "image/build/release-assets.sh", source, output], {
        MINISIGN_SECRET_KEY: "",
        MINISIGN_PASSWORD: "",
      });
      expect(rejected.exitCode).not.toBe(0);
      expect(existsSync(join(output, "ais-live.img"))).toBe(false);
      expect(existsSync(join(output, "SHA256SUMS"))).toBe(false);
      expect(existsSync(join(output, "SHA256SUMS.minisig"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
