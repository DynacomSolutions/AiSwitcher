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
.pill .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #d4d4d8; }
.pill .text b { color: #fff; font-weight: 600; }
.pill button { all: unset; box-sizing: border-box; cursor: pointer; padding: 3px 13px; border-radius: 999px; font-weight: 600; font-size: 12.5px; color: #fecaca;
  background: rgba(239,68,68,.18); border: 1px solid rgba(239,68,68,.45); transition: background 140ms ease, color 140ms ease; }
.pill button:hover { background: #ef4444; color: #fff; }
.pill button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .glow.on, .pill .dot { animation: none; } .pill { transition: opacity 120ms; } }
`;

export interface Indicator {
  show(identity: string, label: string, color: string): void;
  hide(): void;
  destroy(): void;
}

export function createIndicator(root: ShadowRoot, onStop: () => void): Indicator {
  const glow = document.createElement("div");
  glow.className = "glow";
  const pill = document.createElement("div");
  pill.className = "pill";
  pill.setAttribute("role", "status");
  pill.innerHTML = `<span class="dot"></span><span class="brand">AIS</span><span class="text"></span><button type="button">Stop</button>`;
  const text = pill.querySelector<HTMLElement>(".text")!;
  const button = pill.querySelector<HTMLButtonElement>("button")!;
  button.addEventListener("click", ev => { ev.stopPropagation(); onStop(); });
  let shown = false;

  return {
    show(identity, label, color) {
      if (!glow.isConnected) root.append(glow, pill);
      for (const n of [glow, pill]) n.style.setProperty("--c", color);
      text.replaceChildren();
      const b = document.createElement("b");
      b.textContent = identity;
      text.append(b, " is controlling this tab");
      pill.title = label;
      button.setAttribute("aria-label", `Stop ${identity} controlling this tab`);
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
