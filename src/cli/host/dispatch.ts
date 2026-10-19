import { CliUsageError } from "../errors.ts";
import { runHostStdio } from "../../host/adapter.ts";

export async function runHostCommand(rest: string[], flags: Record<string, string | true>): Promise<void> {
  if (flags.stdio !== true || rest.length !== 0 || Object.keys(flags).some((name) => name !== "stdio")) {
    throw new CliUsageError("Usage: ais host --stdio");
  }
  await runHostStdio();
}
