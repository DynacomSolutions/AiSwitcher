// Tool argument shapes and JSON Schemas shared by the Chrome extension (validation)
// and the MCP shim (tool listing). Dependency-free: type-only import of the tool list.
import type { BrowserTool } from "./protocol.ts";

export type ExtensionTool = Exclude<BrowserTool, "list_browsers">;

/** Screenshot-space point: pixels of the most recent screenshot of that tab. */
export type Coordinate = [number, number];

export interface TabArgs { tabId: number }
export interface ElementTarget extends TabArgs { ref?: string; coordinate?: Coordinate }

export interface ToolArgs {
  tabs_context: Record<string, never>;
  tabs_create: { url?: string };
  adopt_tab: TabArgs;
  navigate: TabArgs & { url: string };
  screenshot: TabArgs;
  read_page: TabArgs & { filter?: "interactive" | "all" };
  find: TabArgs & { query: string };
  click: ElementTarget & { button?: "left" | "right" | "middle"; clickCount?: number };
  type: TabArgs & { text: string; ref?: string };
  key: TabArgs & { key: string; repeat?: number };
  scroll: ElementTarget & { direction?: "up" | "down" | "left" | "right"; amount?: number };
  hover: ElementTarget;
  form_input: TabArgs & { ref: string; value: string | number | boolean };
  javascript: TabArgs & { code: string };
  get_console: TabArgs & { onlyErrors?: boolean; pattern?: string; clear?: boolean };
  get_network: TabArgs & { urlPattern?: string; clear?: boolean };
  wait: { seconds: number };
  upload_file: TabArgs & { ref: string; paths: string[] };
  resize: TabArgs & { width: number; height: number };
  close_tab: TabArgs;
}

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  oneOf?: JsonSchema[];
}

const tabId: JsonSchema = { type: "number", description: "Tab id from tabs_context or tabs_create." };
const ref: JsonSchema = { type: "string", description: "Element ref such as ref_12, returned by read_page or find." };
const coordinate: JsonSchema = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] in pixels of the latest screenshot of this tab. Use instead of ref." };

function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOL_SCHEMAS: Record<ExtensionTool, { description: string; inputSchema: JsonSchema }> = {
  tabs_context: { description: "List the tabs this session owns (actionable) and the user's other tabs (read-only, adopt with adopt_tab).", inputSchema: obj({}) },
  tabs_create: { description: "Open a new tab in this session's tab group and return its tabId.", inputSchema: obj({ url: { type: "string", description: "Optional URL to open." } }) },
  adopt_tab: { description: "Move one of the user's tabs into this session's tab group so it can be controlled.", inputSchema: obj({ tabId }, ["tabId"]) },
  navigate: { description: "Navigate a tab to a URL, or go \"back\" or \"forward\" in its history.", inputSchema: obj({ tabId, url: { type: "string", description: "http(s) URL, or the literal \"back\" or \"forward\"." } }, ["tabId", "url"]) },
  screenshot: { description: "Capture a JPEG screenshot of the tab viewport, scaled to at most 1568 px on the long edge. Coordinates passed to click, hover and scroll are in this image's pixel space.", inputSchema: obj({ tabId }, ["tabId"]) },
  read_page: { description: "Return the accessibility tree of the page as text with element refs (ref_N) usable by click, type, form_input, scroll and upload_file.", inputSchema: obj({ tabId, filter: { type: "string", enum: ["interactive", "all"], description: "interactive (default) lists only actionable elements." } }, ["tabId"]) },
  find: { description: "Find elements whose role, name or value contains the query text. Returns matching refs.", inputSchema: obj({ tabId, query: { type: "string" } }, ["tabId", "query"]) },
  click: { description: "Click an element by ref, or a point by coordinate.", inputSchema: obj({ tabId, ref, coordinate, button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "number", minimum: 1, maximum: 3, description: "2 for double click." } }, ["tabId"]) },
  type: { description: "Type text into the focused element, or into the element given by ref.", inputSchema: obj({ tabId, text: { type: "string" }, ref }, ["tabId", "text"]) },
  key: { description: "Press keys, for example \"Enter\", \"ctrl+a\" or \"Tab Tab Enter\" (space separated sequence).", inputSchema: obj({ tabId, key: { type: "string" }, repeat: { type: "number", minimum: 1, maximum: 100 } }, ["tabId", "key"]) },
  scroll: { description: "Scroll the page (or the element or point given) in a direction, or scroll a ref into view when no direction is given.", inputSchema: obj({ tabId, ref, coordinate, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", minimum: 1, maximum: 50, description: "Wheel ticks, default 3." } }, ["tabId"]) },
  hover: { description: "Move the pointer over an element by ref, or a point by coordinate.", inputSchema: obj({ tabId, ref, coordinate }, ["tabId"]) },
  form_input: { description: "Set the value of an input, textarea, select or checkbox by ref.", inputSchema: obj({ tabId, ref, value: { description: "String, number or boolean." } }, ["tabId", "ref", "value"]) },
  javascript: { description: "Evaluate JavaScript in the page and return the JSON result.", inputSchema: obj({ tabId, code: { type: "string" } }, ["tabId", "code"]) },
  get_console: { description: "Return console messages and log entries collected since the extension attached to the tab.", inputSchema: obj({ tabId, onlyErrors: { type: "boolean" }, pattern: { type: "string", description: "Case-insensitive substring filter." }, clear: { type: "boolean" } }, ["tabId"]) },
  get_network: { description: "Return network requests collected since the extension attached to the tab.", inputSchema: obj({ tabId, urlPattern: { type: "string", description: "Case-insensitive substring filter." }, clear: { type: "boolean" } }, ["tabId"]) },
  wait: { description: "Wait for a number of seconds (at most 120).", inputSchema: obj({ seconds: { type: "number", minimum: 0, maximum: 120 } }, ["seconds"]) },
  upload_file: { description: "Set files on a file input by ref. Paths are on the machine running the browser.", inputSchema: obj({ tabId, ref, paths: { type: "array", items: { type: "string" }, minItems: 1 } }, ["tabId", "ref", "paths"]) },
  resize: { description: "Resize the browser window containing the tab.", inputSchema: obj({ tabId, width: { type: "number", minimum: 200, maximum: 10000 }, height: { type: "number", minimum: 200, maximum: 10000 } }, ["tabId", "width", "height"]) },
  close_tab: { description: "Close a tab owned by this session.", inputSchema: obj({ tabId }, ["tabId"]) },
};

function check(schema: JsonSchema, value: unknown, path: string): string | undefined {
  if (schema.type === undefined) return undefined;
  switch (schema.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
      return undefined;
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} items`;
      for (const [i, item] of value.entries()) {
        const err = schema.items ? check(schema.items, item, `${path}[${i}]`) : undefined;
        if (err) return err;
      }
      return undefined;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (record[key] === undefined) return `${path === "args" ? "" : `${path}.`}${key} is required`;
      for (const [key, v] of Object.entries(record)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) return `unknown argument ${key}`;
          continue;
        }
        const err = check(sub, v, key);
        if (err) return err;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Returns an error message when args do not satisfy the tool schema, else undefined. */
export function validateToolArgs(tool: ExtensionTool, args: unknown): string | undefined {
  return check(TOOL_SCHEMAS[tool].inputSchema, args, "args");
}
