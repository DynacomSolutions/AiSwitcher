import type { ParsedArgs } from "../args.ts";
import { runBrowserExtension, type ExtensionDeps } from "./extension.ts";
import { runBrowserAdmin, type BrowserCliDeps } from "./admin.ts";

export type { BrowserCliDeps };

const defaultDeps = (): BrowserCliDeps => ({
  fetch,
  kubectl: async () => ({ code: 0, stderr: "" }),
  out: (line) => console.info(line),
  now: () => Date.now(),
});

export async function runBrowserCommand(positionals: string[], flags: ParsedArgs["flags"], deps: Partial<BrowserCliDeps> & Partial<ExtensionDeps> = {}): Promise<void> {
  const [sub, ...rest] = positionals;
  if (sub === "mcp") {
    const { runMcpShim } = await import("../../browser/mcp-shim.ts");
    await runMcpShim();
    return;
  }
  if (sub === "extension") {
    await runBrowserExtension(rest, flags, { ...(deps.extensionDir !== undefined ? { extensionDir: deps.extensionDir } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.out ? { out: deps.out } : {}), ...(deps.env ? { env: deps.env } : {}), ...(deps.platform ? { platform: deps.platform } : {}), ...(deps.run ? { run: deps.run } : {}) });
    return;
  }
  await runBrowserAdmin(sub, rest, flags, { ...defaultDeps(), ...deps });
}
