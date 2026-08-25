/** Best-effort clipboard copy. Tries each real clipboard tool available for
 * the current platform in turn (macOS only ever has one; Linux varies by
 * display server/session, so several are tried) — returns false rather than
 * throwing if none are available, since "the shortcut quietly does nothing"
 * is a far better failure mode here than crashing an interactive picker. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "linux"
        ? [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]
        : [];

  for (const [cmd, args] of candidates) {
    try {
      const proc = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      const exitCode = await proc.exited;
      if (exitCode === 0) return true;
    } catch {
      // Binary not found (or failed to spawn) — try the next candidate.
    }
  }
  return false;
}
