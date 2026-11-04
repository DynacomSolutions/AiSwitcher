// Agent cursor: an SVG pointer that glides to the target (300 ms) and ripples on click. Plain DOM inside a shadow root.

export const MOVE_MS = 300;
const EASING = "cubic-bezier(0.33, 0.9, 0.35, 1)";
const IDLE_HIDE_MS = 4000;

export type CursorKind = "click" | "hover" | "type" | "scroll" | "key";

export const CURSOR_CSS = `
.cursor { position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0; transition: opacity 220ms ease; will-change: transform; }
.cursor.visible { opacity: 1; }
.cursor svg { position: absolute; left: -3px; top: -2px; width: 26px; height: 26px; overflow: visible; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
.cursor .arrow { fill: var(--c); stroke: #fff; stroke-width: 1.6; stroke-linejoin: round; }
.cursor .tag { position: absolute; left: 16px; top: 20px; padding: 2px 8px 2px 7px; border-radius: 999px; background: var(--c); color: #fff;
  font: 600 11px/16px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .01em; white-space: nowrap;
  box-shadow: 0 1px 4px rgba(0,0,0,.3), 0 0 0 1.5px rgba(255,255,255,.9); text-shadow: 0 1px 1px rgba(0,0,0,.25); }
.ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2px solid var(--c);
  background: radial-gradient(circle, color-mix(in srgb, var(--c) 35%, transparent), transparent 70%); opacity: 0; pointer-events: none;
  animation: ais-ripple 620ms cubic-bezier(.2,.7,.3,1) forwards; }
.ripple.soft { width: 30px; height: 30px; margin: -15px 0 0 -15px; border-width: 1.5px; animation-duration: 900ms; }
@keyframes ais-ripple { 0% { transform: scale(.25); opacity: .85; } 70% { opacity: .35; } 100% { transform: scale(1.7); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ripple { animation-duration: 1ms; } }
`;

const ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="arrow" d="M3 2.2 L3 19.4 L7.5 15.2 L10.6 22 L13.7 20.6 L10.7 14 L17 13.6 Z"/></svg>`;

export interface Cursor {
  el: HTMLElement;
  moveTo(x: number, y: number, label: string, color: string): Promise<void>;
  ripple(x: number, y: number, kind: CursorKind, color: string): void;
  hide(): void;
  destroy(): void;
}

export function createCursor(root: ShadowRoot): Cursor {
  const el = document.createElement("div");
  el.className = "cursor";
  el.innerHTML = `${ARROW}<span class="tag"></span>`;
  const tag = el.querySelector<HTMLElement>(".tag")!;
  let at: { x: number; y: number } | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const transform = (x: number, y: number) => `translate3d(${Math.round(x * 100) / 100}px, ${Math.round(y * 100) / 100}px, 0)`;

  return {
    el,
    async moveTo(x, y, label, color) {
      if (!el.isConnected) root.append(el);
      el.style.setProperty("--c", color);
      tag.textContent = label;
      clearTimeout(idle);
      // First appearance: emerge from the bottom centre, where the controlling pill sits.
      const from = at ?? { x: innerWidth / 2, y: innerHeight - 24 };
      el.style.transform = transform(from.x, from.y);
      el.classList.add("visible");
      at = { x, y };
      el.style.transform = transform(x, y);
      const anim = el.animate([{ transform: transform(from.x, from.y) }, { transform: transform(x, y) }], { duration: MOVE_MS, easing: EASING });
      await anim.finished.catch(() => {});
      idle = setTimeout(() => el.classList.remove("visible"), IDLE_HIDE_MS);
    },
    ripple(x, y, kind, color) {
      if (kind === "key" || kind === "scroll") return;
      const r = document.createElement("div");
      r.className = kind === "click" ? "ripple" : "ripple soft";
      r.style.cssText = `left:${x}px;top:${y}px;--c:${color}`;
      r.addEventListener("animationend", () => r.remove(), { once: true });
      root.append(r);
    },
    hide() { clearTimeout(idle); el.classList.remove("visible"); },
    destroy() { clearTimeout(idle); el.remove(); at = undefined; },
  };
}
