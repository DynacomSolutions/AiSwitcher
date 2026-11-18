// Tool argument shapes and JSON Schemas shared by the Chrome extension (validation)
// and the MCP shim (tool listing). Dependency-free: type-only import of the tool list.
import type { BrowserTool } from "./protocol.ts";

export type ExtensionTool = Exclude<BrowserTool, "list_browsers">;

/** Screenshot-space point: pixels of the most recent screenshot of that tab. */
export type Coordinate = [number, number];

export interface TabArgs { tabId: number }
export interface ElementTarget extends TabArgs { ref?: string; coordinate?: Coordinate }

/** A file to upload: its content, never a path. Nothing is read from the disk of the machine that runs Chrome. */
export interface UploadFile { name: string; mimeType: string; data: string }
/** Total decoded size of the files in one upload_file call. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;

export interface ToolArgs {
  tabs_context: Record<string, never>;
  tabs_create: { url?: string; groupId?: number };
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
  upload_file: ElementTarget & { files: UploadFile[] };
  javascript: TabArgs & { code: string };
  get_console: TabArgs & { onlyErrors?: boolean; pattern?: string; clear?: boolean };
  get_network: TabArgs & { urlPattern?: string; clear?: boolean };
  wait: { seconds: number };
  resize: TabArgs & { width: number; height: number };
  close_tab: TabArgs;
  handle_dialog: TabArgs & { accept: boolean; promptText?: string };
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
  tabs_context: { description: "List the tabs this session owns or was granted (actionable; scope own or granted) and the user's other tabs (read-only, adopt with adopt_tab).", inputSchema: obj({}) },
  tabs_create: { description: "Open a new tab in this session's tab group and return its tabId. Pass groupId to open it inside a tab group the user granted to this session instead. Keep the tab open while the user must act in it. Close it with close_tab only when the work in it is finished.", inputSchema: obj({ url: { type: "string", description: "Optional URL to open." }, groupId: { type: "number", description: "Optional id of a granted group (see grantedGroups in tabs_context)." } }) },
  adopt_tab: { description: "Move one of the user's tabs into this session's tab group so it can be controlled.", inputSchema: obj({ tabId }, ["tabId"]) },
  navigate: { description: "Navigate a tab to a URL, or go \"back\" or \"forward\" in its history.", inputSchema: obj({ tabId, url: { type: "string", description: "http(s) URL, or the literal \"back\" or \"forward\"." } }, ["tabId", "url"]) },
  screenshot: { description: "Capture a JPEG screenshot of the tab viewport, scaled to at most 1568 px on the long edge. Coordinates passed to click, hover and scroll are in this image's pixel space.", inputSchema: obj({ tabId }, ["tabId"]) },
  read_page: { description: "Return the accessibility tree of the page as text with element refs (ref_N) usable by click, type, form_input and scroll.", inputSchema: obj({ tabId, filter: { type: "string", enum: ["interactive", "all"], description: "interactive (default) lists only actionable elements." } }, ["tabId"]) },
  find: { description: "Find elements whose role, name or value contains the query text. Returns matching refs.", inputSchema: obj({ tabId, query: { type: "string" } }, ["tabId", "query"]) },
  click: { description: "Click an element by ref, or a point by coordinate.", inputSchema: obj({ tabId, ref, coordinate, button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "number", minimum: 1, maximum: 3, description: "2 for double click." } }, ["tabId"]) },
  type: { description: "Type text into the focused element, or into the element given by ref.", inputSchema: obj({ tabId, text: { type: "string" }, ref }, ["tabId", "text"]) },
  key: { description: "Press keys, for example \"Enter\", \"ctrl+a\" or \"Tab Tab Enter\" (space separated sequence).", inputSchema: obj({ tabId, key: { type: "string" }, repeat: { type: "number", minimum: 1, maximum: 100 } }, ["tabId", "key"]) },
  scroll: { description: "Scroll the page (or the element or point given) in a direction, or scroll a ref into view when no direction is given.", inputSchema: obj({ tabId, ref, coordinate, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", minimum: 1, maximum: 50, description: "Wheel ticks, default 3." } }, ["tabId"]) },
  hover: { description: "Move the pointer over an element by ref, or a point by coordinate.", inputSchema: obj({ tabId, ref, coordinate }, ["tabId"]) },
  form_input: { description: "Set the value of an input, textarea, select or checkbox by ref.", inputSchema: obj({ tabId, ref, value: { description: "String, number or boolean." } }, ["tabId", "ref", "value"]) },
  upload_file: {
    description: "Upload files to the page. Give the file input, or the button that opens the file chooser, by ref or coordinate: it is clicked, the chooser is held back (no dialog opens) and the files are set on its input. Works inside iframes.",
    inputSchema: obj({
      tabId, ref, coordinate,
      files: {
        type: "array", minItems: 1, maxItems: MAX_UPLOAD_FILES, description: "File content. A path is never accepted.",
        items: obj({ name: { type: "string", description: "File name without a folder." }, mimeType: { type: "string" }, data: { type: "string", description: "Content as base64." } }, ["name", "mimeType", "data"]),
      },
    }, ["tabId", "files"]),
  },
  javascript: { description: "Evaluate JavaScript in the page and return the JSON result.", inputSchema: obj({ tabId, code: { type: "string" } }, ["tabId", "code"]) },
  get_console: { description: "Return console messages and log entries collected since the extension attached to the tab.", inputSchema: obj({ tabId, onlyErrors: { type: "boolean" }, pattern: { type: "string", description: "Case-insensitive substring filter." }, clear: { type: "boolean" } }, ["tabId"]) },
  get_network: { description: "Return network requests collected since the extension attached to the tab.", inputSchema: obj({ tabId, urlPattern: { type: "string", description: "Case-insensitive substring filter." }, clear: { type: "boolean" } }, ["tabId"]) },
  wait: { description: "Wait for a number of seconds (at most 120).", inputSchema: obj({ seconds: { type: "number", minimum: 0, maximum: 120 } }, ["seconds"]) },
  resize: { description: "Emulate a viewport size for the tab, like DevTools responsive mode. The browser window is never resized or moved. The override ends when the agent session ends (the debugger detaches).", inputSchema: obj({ tabId, width: { type: "number", minimum: 200, maximum: 10000 }, height: { type: "number", minimum: 200, maximum: 10000 } }, ["tabId", "width", "height"]) },
  close_tab: { description: "Close a tab owned by this session. Close it only when the work in it is fully finished: never while a step in it waits for the user (sign-in, 2FA, CAPTCHA, consent, a question about the page). If the page asks \"Leave site?\" (a beforeunload dialog, the page has unsaved changes), the tab stays open and the call fails with dialog_open: see handle_dialog.", inputSchema: obj({ tabId }, ["tabId"]) },
  handle_dialog: {
    description: "Answer the JavaScript dialog (alert, confirm, prompt or beforeunload) open on a tab. While one is open, other calls on that tab fail with dialog_open, and tabs_context shows it. accept false dismisses it (Cancel; for beforeunload: stay on the page). accept true presses OK; for beforeunload it leaves the page or closes the tab and DISCARDS THE USER'S UNSAVED CHANGES: only accept a beforeunload dialog when the user asked you to discard them. Nothing is ever accepted automatically.",
    inputSchema: obj({ tabId, accept: { type: "boolean", description: "true for OK (leave the page, for beforeunload), false for Cancel (stay)." }, promptText: { type: "string", description: "Text to enter in a prompt dialog before accepting." } }, ["tabId", "accept"]),
  },
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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size of a base64 string, or undefined when it is not base64. */
export function base64Bytes(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/** Checks the schema cannot express: plain file names (never a path), real base64 and the size limit. */
function checkUpload(files: UploadFile[]): string | undefined {
  let total = 0;
  for (const [i, f] of files.entries()) {
    if (f.name === "" || f.name.length > 255 || f.name === "." || f.name === ".." || /[\\/\0]/.test(f.name)) return `files[${i}].name must be a file name without a folder`;
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(f.mimeType) || f.mimeType.length > 255) return `files[${i}].mimeType must be a MIME type such as image/png`;
    const size = base64Bytes(f.data);
    if (size === undefined) return `files[${i}].data must be base64`;
    total += size;
  }
  return total > MAX_UPLOAD_BYTES ? `files are ${total} bytes in total; the limit is ${MAX_UPLOAD_BYTES} bytes` : undefined;
}

/** Returns an error message when args do not satisfy the tool schema, else undefined. */
export function validateToolArgs(tool: ExtensionTool, args: unknown): string | undefined {
  const err = check(TOOL_SCHEMAS[tool].inputSchema, args, "args");
  if (err) return err;
  return tool === "upload_file" ? checkUpload((args as ToolArgs["upload_file"]).files) : undefined;
}
