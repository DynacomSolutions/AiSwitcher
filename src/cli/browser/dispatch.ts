import type { ParsedArgs } from "../args.ts";
import { runBrowserAdmin, type BrowserCliDeps } from "./admin.ts";

export type { BrowserCliDeps };

const defaultDeps = (): BrowserCliDeps => ({
  fetch,
  kubectl: async () => ({ code: 0, stderr: "" }),
  out: (line) => console.info(line),
  now: () => Date.now(),
});

export async function runBrowserCommand(positionals: string[], flags: ParsedArgs["flags"], deps: Partial<BrowserCliDeps> = {}): Promise<void> {
  const [sub, ...rest] = positionals;
  if (sub === "mcp") {
    const { runMcpShim } = await import("../../browser/mcp-shim.ts");
    await runMcpShim();
    return;
  }
  await runBrowserAdmin(sub, rest, flags, { ...defaultDeps(), ...deps });
}
