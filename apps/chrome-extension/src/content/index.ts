// Content script injected on demand into controlled tabs. Exposes globalThis.__aisOverlay, which lives in the extension's
// isolated world: page scripts cannot see it. The shadow root is closed and kept in this closure for the same reason.
import { createCursor, CURSOR_CSS, type CursorKind } from "./cursor.ts";
import { createIndicator, INDICATOR_CSS } from "./indicator.ts";

const HOST_ID = "ais-browser-overlay";
/** No tool call for this long: the session is treated as over and the overlay goes away. */
const SESSION_IDLE_MS = 90_000;

interface MarkArg { identity: string; label: string; color: string }
interface ActionArg extends MarkArg { x: number; y: number; kind: CursorKind }

/** Injected by build.ts: true only in the e2e build. */
declare const AIS_E2E: boolean;

const g = globalThis as unknown as { __aisOverlay?: unknown };

function init(): void {
  let host: HTMLElement | null = null;
  let root: ShadowRoot | undefined;
  let cursor: ReturnType<typeof createCursor> | undefined;
  let indicator: ReturnType<typeof createIndicator> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  let stopButton: HTMLButtonElement | undefined;

  function applySuspended(): void {
    if (host) host.style.visibility = suspended ? "hidden" : "visible";
  }

  /** The service worker is gone (extension reloaded or updated): this script is orphaned, so take the overlay down. */
  function orphaned(): boolean { return !chrome.runtime?.id; }

  function requestStop(): void {
    try {
      void Promise.resolve(chrome.runtime.sendMessage({ type: "ais-stop" })).catch(() => { if (orphaned()) api.unmark(); });
    } catch {
      if (orphaned()) api.unmark();
    }
  }

  function ensure(): { cursor: NonNullable<typeof cursor>; indicator: NonNullable<typeof indicator> } {
    if (host?.isConnected && root && cursor && indicator) return { cursor, indicator };
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true"); // keeps it out of the accessibility tree agents read
    host.setAttribute("style", "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; contain: layout style;");
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `${CURSOR_CSS}\n${INDICATOR_CSS}`;
    root.append(style);
    cursor = createCursor(root);
    indicator = createIndicator(root, requestStop);
    applySuspended();
    (document.documentElement ?? document).append(host);
    return { cursor, indicator };
  }

  function touch(): void {
    clearTimeout(expiry);
    expiry = setTimeout(() => api.unmark(), SESSION_IDLE_MS);
  }

  const rect = (el: Element | null | undefined): { x: number; y: number; w: number; h: number } | null => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  };

  const api = {
    mark(a: MarkArg): string {
      if (orphaned()) { api.unmark(); return "orphaned"; }
      ensure().indicator.show(a.identity, a.label, a.color);
      touch();
      return "ok";
    },
    async action(a: ActionArg): Promise<string> {
      if (orphaned()) { api.unmark(); return "orphaned"; }
      const o = ensure();
      o.indicator.show(a.identity, a.label, a.color);
      touch();
      if (a.kind !== "key") {
        await o.cursor.moveTo(a.x, a.y, a.identity, a.color);
        o.cursor.ripple(a.x, a.y, a.kind, a.color);
      }
      return "ok";
    },
    /** Hide while the agent captures the page or sends synthetic mouse input. */
    suspend(): string { suspended = true; applySuspended(); return "ok"; },
    restore(): string { suspended = false; applySuspended(); return "ok"; },
    unmark(): string {
      clearTimeout(expiry);
      cursor?.destroy();
      indicator?.destroy();
      host?.remove();
      host = null;
      root = undefined;
      cursor = undefined;
      indicator = undefined;
      suspended = false;
      return "ok";
    },
  };
  // Inspection hooks for the end-to-end test only: compiled out of release builds (build.ts defines AIS_E2E as false).
  if (AIS_E2E) {
    Object.assign(api, {
      snapshot(): unknown {
        if (!root) return null;
        stopButton = root.querySelector("button") ?? undefined;
        return {
          suspended,
          hostVisibility: host?.style.visibility ?? "",
          pill: root.querySelector(".pill")?.textContent ?? "",
          pillOn: root.querySelector(".pill.on") !== null,
          glowOn: root.querySelector(".glow.on") !== null,
          cursor: rect(root.querySelector(".cursor")),
          stop: rect(stopButton),
        };
      },
      /** Pauses the cursor glide once it is at least `ms` in, so a test can capture it mid-move. */
      pauseCursorAt(ms: number): Promise<boolean> {
        return new Promise(resolve => {
          const t0 = Date.now();
          const tick = setInterval(() => {
            const a = root?.getAnimations().find(x => x.playState === "running" && Number(x.currentTime) >= ms);
            if (a) { a.pause(); clearInterval(tick); resolve(true); } else if (Date.now() - t0 > 5000) { clearInterval(tick); resolve(false); }
          }, 4);
        });
      },
      resumeAnimations(): string { root?.getAnimations().forEach(a => { if (a.playState === "paused") a.play(); }); return "ok"; },
      /** A synthetic (untrusted) click on Stop, to prove the guard ignores it. */
      untrustedStopClick(): string { root?.querySelector("button")?.click(); return "ok"; }
    });
  }
  g.__aisOverlay = api;
}

if (!g.__aisOverlay) init();
