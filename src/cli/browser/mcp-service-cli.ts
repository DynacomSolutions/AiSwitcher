import { CliUsageError } from "../errors.ts";
import { browserMcpServiceStatus, installBrowserMcpService, uninstallBrowserMcpService, type McpServiceOptions } from "./mcp-service.ts";

/** `ais browser mcp-service install|status|uninstall`. */
export async function runMcpServiceCommand(args: string[], out: (line: string) => void, options: McpServiceOptions = {}): Promise<void> {
  const [action] = args;
  if (action === "install") {
    const r = await installBrowserMcpService(options);
    out(`browser mcp service: ${r.action}; unit at ${r.path}`);
    return;
  }
  if (action === "uninstall") {
    const r = await uninstallBrowserMcpService(options);
    out(r.removed ? "browser mcp service: removed; launches use the stdio server again" : "browser mcp service: was not installed");
    return;
  }
  if (action === "status" || action === undefined) {
    const s = await browserMcpServiceStatus(options);
    out(`browser mcp service: ${s.installed ? "installed" : "not installed"}, unit ${s.unit}, ${s.answering ? "answering" : "not answering"} on 127.0.0.1:${s.port}; launches use ${s.installed ? "http" : "stdio"}`);
    return;
  }
  throw new CliUsageError("Usage: ais browser mcp-service [install|status|uninstall]");
}
