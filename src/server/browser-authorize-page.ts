// HTML for the extension sign-in page (/browser/authorize). Self-contained: no scripts, one inline stylesheet, light and dark.

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--muted:#6b6b73;--line:#e4e2dc;--accent:#c96442;--accent-ink:#fff;--bad:#d23f3f;--bad-bg:#fbe7e7;--shadow:0 1px 2px rgba(20,20,20,.06),0 12px 32px rgba(20,20,20,.08)}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1e;--card:#26262a;--ink:#f2f1ee;--muted:#a0a0a8;--line:#36363b;--accent:#e0805e;--accent-ink:#1b1b1e;--bad:#ef6b6b;--bad-bg:#3c2224;--shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{width:100%;max-width:440px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:17px;letter-spacing:-.01em;margin:0 2px 18px}
.mark{width:26px;height:26px;border-radius:8px;background:conic-gradient(from 210deg,var(--accent),#d9a441,var(--accent));position:relative}
.mark::after{content:"";position:absolute;inset:7px;border-radius:3px;background:var(--bg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:var(--shadow)}
h1{margin:0 0 8px;font-size:23px;line-height:1.25;letter-spacing:-.02em;font-weight:700;overflow-wrap:anywhere}
.label{color:var(--accent)}
p{margin:0}.lead{color:var(--muted)}
form{display:flex;flex-direction:column;gap:16px;margin-top:22px}
.field{display:flex;flex-direction:column;gap:6px}
.field span{font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
select{appearance:none;font:inherit;font-size:15px;color:var(--ink);background:var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23888' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 14px center;border:1px solid var(--line);border-radius:12px;padding:11px 38px 11px 14px;width:100%}
select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
.hint{font-size:12.5px;color:var(--muted)}
.actions{display:flex;gap:10px;margin-top:4px}
button{font:inherit;font-weight:650;font-size:15px;cursor:pointer;border-radius:12px;padding:12px 18px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button:hover{border-color:color-mix(in srgb,var(--ink) 30%,var(--line))}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{flex:1;background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.primary:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}
.err{background:var(--bad-bg);color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);border-radius:12px;padding:12px 14px;font-weight:550;margin-top:14px}
.foot{margin:16px 4px 0;font-size:12.5px;color:var(--muted);text-align:center}
`;

const shell = (title: string, inner: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><div class="brand"><span class="mark" aria-hidden="true"></span>AIS Browser</div>${inner}</div></body></html>`;

export interface AuthorizeView {
  label: string;
  redirectUri: string;
  state: string;
  csrf: string;
  pools: string[];
  identities: string[];
  /** "pool:<name>" or "identity:<name>" selected first. */
  selected: string;
}

export function renderAuthorize(v: AuthorizeView): string {
  const opt = (value: string, text: string): string => `<option value="${escapeHtml(value)}"${value === v.selected ? " selected" : ""}>${escapeHtml(text)}</option>`;
  const pools = v.pools.length ? `<optgroup label="Pools">${v.pools.map((p) => opt(`pool:${p}`, p)).join("")}</optgroup>` : "";
  const ids = v.identities.length ? `<optgroup label="Identities">${v.identities.map((i) => opt(`identity:${i}`, i)).join("")}</optgroup>` : "";
  return shell(`Connect ${v.label} to AIS`, `<div class="card">
<h1>Connect <span class="label">${escapeHtml(v.label)}</span> to AIS</h1>
<p class="lead">This lets AIS agents open and control tabs in that Chrome profile. You can pause or stop it from the extension at any time.</p>
<form method="post" action="authorize">
<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(v.redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(v.state)}">
<input type="hidden" name="label" value="${escapeHtml(v.label)}">
<label class="field"><span>Agents that may use this browser</span><select name="target">${pools}${ids}</select></label>
<p class="hint">Pick a pool to share the browser with every agent in it, or a single identity.</p>
<div class="actions"><button class="primary" type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="cancel">Cancel</button></div>
</form></div><p class="foot">Only approve if you just clicked Connect in the AIS Browser extension.</p>`);
}

export function renderError(message: string): string {
  return shell("AIS Browser", `<div class="card"><h1>Cannot connect</h1><p class="err" role="alert">${escapeHtml(message)}</p><p class="foot">Open the AIS Browser side panel and try Connect again.</p></div>`);
}
