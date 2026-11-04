import { BROWSER_TOOLS, type BrowserTool } from "./protocol.ts";
import { TOOL_SCHEMAS, type ExtensionTool, type JsonSchema } from "./tool-args.ts";

export interface McpTool {
  name: BrowserTool;
  description: string;
  inputSchema: JsonSchema;
}

const BROWSER_PROP: JsonSchema = { type: "string", description: "Browser binding name. Required only when several browsers are connected (see list_browsers)." };

/** Every browser tool as an MCP tool; each one except list_browsers gains an optional `browser` argument. */
export function mcpTools(): McpTool[] {
  return BROWSER_TOOLS.map((name) => {
    if (name === "list_browsers") {
      return { name, description: "List the connected browsers this identity may drive.", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
    }
    const schema = TOOL_SCHEMAS[name as ExtensionTool];
    return {
      name,
      description: schema.description,
      inputSchema: { ...schema.inputSchema, properties: { ...schema.inputSchema.properties, browser: BROWSER_PROP } },
    };
  });
}
