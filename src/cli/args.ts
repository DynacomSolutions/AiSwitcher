import { CliUsageError } from "./errors.ts";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/**
 * Fold the natural space form "--flag value" into "--flag=value" for the
 * named valued flags, so commands like `ais herdr --remote <target>` parse
 * instead of the value landing in positionals. Only BARE occurrences of a
 * named flag are folded (an existing "--flag=value" is left alone), the
 * token after a "--" end-of-options marker is forwarded untouched, and a
 * following flag-looking token (leading "-") is never consumed as a value —
 * the bare flag then reaches stringFlag's own "requires a value" error.
 */
export function foldValuedFlags(argv: string[], valuedFlags: readonly string[]): string[] {
  const valued = new Set(valuedFlags);
  const folded: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      folded.push(...argv.slice(i));
      break;
    }
    const next = argv[i + 1];
    if (arg.startsWith("--") && !arg.includes("=") && valued.has(arg.slice(2)) && next !== undefined && !next.startsWith("-")) {
      folded.push(`${arg}=${next}`);
      i++;
      continue;
    }
    folded.push(arg);
  }
  return folded;
}

/**
 * Minimal argv parser for `ais` subcommands: "--flag=value" or bare "--flag"
 * (boolean true); everything else is a positional. No space-separated
 * "--flag value" form — matches this codebase's existing convention
 * (shared/cli-args.ts's "--identity=<name>") and keeps flag/positional
 * boundaries unambiguous. Commands that want the natural space form fold it
 * first with foldValuedFlags() for their known valued flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = true;
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

/** A flag supplied with no value (bare "--foo") is a usage error wherever a
 * string is expected — it almost always means the caller forgot the "=". */
export function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new CliUsageError(`--${name} requires a value (--${name}=...)`);
  return value;
}

export function requireFlag(flags: ParsedArgs["flags"], name: string): string {
  const value = stringFlag(flags, name);
  if (value === undefined) throw new CliUsageError(`Missing required --${name}=...`);
  return value;
}

export function boolFlag(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

/** Comma-separated list flag, e.g. --directories=a,b -> ["a", "b"]. */
export function listFlag(flags: ParsedArgs["flags"], name: string): string[] | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
