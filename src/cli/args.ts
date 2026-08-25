import { CliUsageError } from "./errors.ts";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/**
 * Minimal argv parser for `ais` subcommands: "--flag=value" or bare "--flag"
 * (boolean true); everything else is a positional. No space-separated
 * "--flag value" form — matches this codebase's existing convention
 * (shared/cli-args.ts's "--identity=<name>") and keeps flag/positional
 * boundaries unambiguous.
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
