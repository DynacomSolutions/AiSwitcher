// "AIS <identity> is controlling this tab" pill with a Stop button, plus a soft glowing border in the identity colour.

export const INDICATOR_CSS = `
.glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 400ms ease;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--c) 78%, transparent), inset 0 0 22px 1px color-mix(in srgb, var(--c) 42%, transparent), inset 0 0 80px color-mix(in srgb, var(--c) 20%, transparent); }
.glow.on { opacity: 1; animation: ais-breathe 3.4s ease-in-out infinite; }
@keyframes ais-breathe { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }
.pill { position: fixed; left: 50%; bottom: 18px; display: flex; align-items: center; gap: 9px; padding: 5px 5px 5px 13px; max-width: calc(100vw - 32px);
  border-radius: 999px; background: rgba(23,23,28,.93); color: #f4f4f5; border: 1px solid rgba(255,255,255,.13);
  box-shadow: 0 8px 28px rgba(0,0,0,.38), 0 0 0 1px rgba(0,0,0,.25), 0 0 18px -4px var(--c);
  font: 500 13px/20px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .005em; pointer-events: auto; user-select: none;
  transform: translate(-50%, 16px); opacity: 0; transition: transform 320ms cubic-bezier(.2,.9,.3,1), opacity 260ms ease; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.pill.on { transform: translate(-50%, 0); opacity: 1; }
.pill .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 0 var(--c); animation: ais-pulse 2s ease-out infinite; }
@keyframes ais-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 70%, transparent); } 80%, 100% { box-shadow: 0 0 0 8px transparent; } }
.pill .brand { font-weight: 700; letter-spacing: .06em; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: color-mix(in srgb, var(--c) 28%, transparent); color: #fff; }
.pill.multi { flex-wrap: wrap; border-radius: 18px; row-gap: 4px; }
.pill .dots { display: flex; gap: 4px; flex: none; }
.pill .dots .dot { width: 8px; height: 8px; }
.pill .stops { display: flex; flex-wrap: wrap; gap: 4px; }
.pill .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #d4d4d8; }
.pill .text b { color: #fff; font-weight: 600; }
.pill button { all: unset; box-sizing: border-box; cursor: pointer; padding: 3px 13px; border-radius: 999px; font-weight: 600; font-size: 12.5px; color: #fecaca;
  background: rgba(239,68,68,.18); border: 1px solid rgba(239,68,68,.45); transition: background 140ms ease, color 140ms ease; }
.pill button:hover { background: #ef4444; color: #fff; }
.pill button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .glow.on, .pill .dot { animation: none; } .pill { transition: opacity 120ms; } }
`;

export interface PillAgent { sessionId: string; label: string; color: string }

export interface Indicator {
  /** `agents` are in mark order. The glow takes the colour of the agent whose id is `lastActive`. */
  show(agents: PillAgent[], lastActive: string): void;
  hide(): void;
  destroy(): void;
}

export interface IndicatorHandlers {
  /** One agent: the legacy profile-wide Stop. */
  stopAll(): void;
  /** Several agents: stop one agent only. */
  stopSession(sessionId: string): void;
  /** Several agents: stop every agent on this tab. */
  stopTab(): void;
}

/** Pool sessions carry `pool:<name>`; the pill shows just the pool name. */
export function displayIdentity(identity: string): string {
  return identity.startsWith("pool:") ? identity.slice(5) : identity;
}

/** The first `max` agents show as dots and names. The rest are only counted. */
export function pillSummary(agents: PillAgent[], max = 3): { dots: PillAgent[]; names: string; more: number } {
  const dots = agents.slice(0, max);
  return { dots, names: dots.map(a => a.label).join(", "), more: agents.length - dots.length };
}

export function createIndicator(root: ShadowRoot, handlers: IndicatorHandlers): Indicator {
  const glow = document.createElement("div");
  glow.className = "glow";
  const pill = document.createElement("div");
  pill.className = "pill";
  pill.setAttribute("role", "status");
  let shown = false;

  // Only a real user click counts: page scripts can dispatch synthetic events, but never trusted ones.
  function stopButton(text: string, name: string, act: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", name);
    b.addEventListener("click", ev => { ev.stopPropagation(); if (ev.isTrusted) act(); });
    return b;
  }
  const span = (cls: string): HTMLSpanElement => { const e = document.createElement("span"); e.className = cls; return e; };

  return {
    show(agents, lastActive) {
      if (agents.length === 0) return;
      const active = agents.find(a => a.sessionId === lastActive) ?? agents[agents.length - 1]!;
      if (!glow.isConnected) root.append(glow, pill);
      for (const n of [glow, pill]) n.style.setProperty("--c", active.color);
      pill.replaceChildren();
      pill.classList.toggle("multi", agents.length > 1);
      const brand = span("brand");
      brand.textContent = "AIS";
      const text = span("text");
      if (agents.length === 1) {
        const only = agents[0]!;
        const dot = span("dot");
        const b = document.createElement("b");
        // The session's chat name, never the identity.
        b.textContent = only.label;
        text.append(b, " is controlling this tab");
        pill.title = only.label;
        pill.append(dot, brand, text, stopButton("Stop", `Stop ${only.label} controlling this tab`, handlers.stopAll));
      } else {
        const sum = pillSummary(agents);
        const dots = span("dots");
        for (const a of sum.dots) { const d = span("dot"); d.style.setProperty("--c", a.color); dots.append(d); }
        const b = document.createElement("b");
        b.textContent = sum.names;
        text.append(b);
        if (sum.more > 0) text.append(` and ${sum.more} more`);
        text.append(" are controlling this tab");
        pill.title = agents.map(a => a.label).join(", ");
        const stops = span("stops");
        for (const a of agents) stops.append(stopButton(`Stop ${a.label}`, `Stop ${a.label}`, () => handlers.stopSession(a.sessionId)));
        stops.append(stopButton("Stop all", "Stop all agents on this tab", handlers.stopTab));
        pill.append(dots, brand, text, stops);
      }
      if (!shown) {
        shown = true;
        // Next frame so the entry transition runs.
        requestAnimationFrame(() => { glow.classList.add("on"); pill.classList.add("on"); });
      }
    },
    hide() {
      shown = false;
      glow.classList.remove("on");
      pill.classList.remove("on");
      setTimeout(() => { if (!shown) { glow.remove(); pill.remove(); } }, 450);
    },
    destroy() { shown = false; glow.remove(); pill.remove(); },
  };
}
