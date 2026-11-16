import { BROWSER_TOOLS, type BrowserTool } from "./protocol.ts";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, TOOL_SCHEMAS, type ExtensionTool, type JsonSchema } from "./tool-args.ts";

export interface McpTool {
  name: BrowserTool;
  description: string;
  inputSchema: JsonSchema;
}

const BROWSER_PROP: JsonSchema = { type: "string", description: "Browser binding name. Required only when several browsers are connected (see list_browsers)." };

/** What the agent passes to upload_file: paths on its own machine. The shim reads them and sends the content as `files`. */
const UPLOAD_PATHS: JsonSchema = {
  type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_UPLOAD_FILES,
  description: `Paths of the files on the machine this agent runs on (not the machine that runs Chrome). At most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB in total.`,
};

/** The agent-facing schema of upload_file: `paths` in place of the `files` the shim sends on. */
function uploadSchema(wire: JsonSchema): JsonSchema {
  const { files: _files, ...rest } = wire.properties ?? {};
  return { ...wire, properties: { ...rest, paths: UPLOAD_PATHS }, required: ["tabId", "paths"] };
}

/** Every browser tool as an MCP tool; each one except list_browsers gains an optional `browser` argument. */
export function mcpTools(): McpTool[] {
  return BROWSER_TOOLS.map((name) => {
    if (name === "list_browsers") {
      return { name, description: "List the connected browsers this identity may drive.", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
    }
    const schema = TOOL_SCHEMAS[name as ExtensionTool];
    const inputSchema = name === "upload_file" ? uploadSchema(schema.inputSchema) : schema.inputSchema;
    return {
      name,
      description: schema.description,
      inputSchema: { ...inputSchema, properties: { ...inputSchema.properties, browser: BROWSER_PROP } },
    };
  });
}
