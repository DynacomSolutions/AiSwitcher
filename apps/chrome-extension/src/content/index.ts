// Content script injected on demand into controlled tabs. Exposes globalThis.__aisOverlay for the service worker.
import { createCursor, CURSOR_CSS, type CursorKind } from "./cursor.ts";
import { createIndicator, INDICATOR_CSS } from "./indicator.ts";

const HOST_ID = "ais-browser-overlay";
/** No tool call for this long: the session is treated as over and the overlay goes away. */
const SESSION_IDLE_MS = 90_000;

interface MarkArg { identity: string; label: string; color: string }
interface ActionArg extends MarkArg { x: number; y: number; kind: CursorKind }

const g = globalThis as unknown as { __aisOverlay?: unknown };

function init(): void {
  let host: HTMLElement | null = null;
  let cursor: ReturnType<typeof createCursor> | undefined;
  let indicator: ReturnType<typeof createIndicator> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function ensure(): { host: HTMLElement; cursor: NonNullable<typeof cursor>; indicator: NonNullable<typeof indicator> } {
    if (host?.isConnected && cursor && indicator) return { host, cursor, indicator };
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("style", "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; contain: layout style;");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `${CURSOR_CSS}\n${INDICATOR_CSS}`;
    root.append(style);
    cursor = createCursor(root);
    indicator = createIndicator(root, () => { void chrome.runtime.sendMessage({ type: "ais-stop" }).catch(() => {}); });
    (document.documentElement ?? document).append(host);
    return { host, cursor, indicator };
  }

  function touch(): void {
    clearTimeout(expiry);
    expiry = setTimeout(() => api.unmark(), SESSION_IDLE_MS);
  }

  const api = {
    mark(a: MarkArg): string {
      ensure().indicator.show(a.identity, a.label, a.color);
      touch();
      return "ok";
    },
    async action(a: ActionArg): Promise<string> {
      const o = ensure();
      o.indicator.show(a.identity, a.label, a.color);
      touch();
      if (a.kind !== "key") {
        await o.cursor.moveTo(a.x, a.y, a.identity, a.color);
        o.cursor.ripple(a.x, a.y, a.kind, a.color);
      }
      return "ok";
    },
    unmark(): string {
      clearTimeout(expiry);
      cursor?.destroy();
      indicator?.destroy();
      host?.remove();
      host = null;
      cursor = undefined;
      indicator = undefined;
      return "ok";
    },
  };
  g.__aisOverlay = api;
}

if (!g.__aisOverlay) init();
