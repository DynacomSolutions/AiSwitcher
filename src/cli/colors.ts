/** Minimal ANSI color helper — hand-rolled rather than a dependency since the
 * palette this CLI needs is small and fixed (see AGENTS.md's stance on
 * hand-rolling over adopting a library when the fit is this narrow).
 * Respects the NO_COLOR (https://no-color.org) and FORCE_COLOR conventions,
 * falling back to TTY detection otherwise so piped/redirected output stays
 * plain. Checked per call (not cached at import) so tests can toggle the env
 * without needing a fresh module instance. */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

/** Exported so a caller that needs to make its OWN render-time decision
 * based on whether color is active (e.g. usage/contribution-graph.ts
 * choosing colored squares vs. a density-character fallback) can ask
 * directly, rather than duplicating colorEnabled's NO_COLOR/FORCE_COLOR/TTY
 * logic. */
export function isColorEnabled(): boolean {
  return colorEnabled();
}

function wrap(open: number | string, close: number | string): (s: string) => string {
  return (s: string) => (colorEnabled() ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

/** xterm-256 foreground color by palette index — used for the
 * contribution-graph's green shade ramp, which needs more distinct shades
 * than the fixed 16-color palette above has room for. */
export function fg256(code: number): (s: string) => string {
  return wrap(`38;5;${code}`, 39);
}
