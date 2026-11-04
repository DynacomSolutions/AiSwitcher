import { realChromeApi } from "../background/chrome-api.ts";
import { clearToken, loadSettings, pollPairing, saveGatewayUrl, startPairing } from "../background/pairing.ts";

const api = realChromeApi();
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let cancel: AbortController | undefined;

function setError(msg: string): void { $("error").textContent = msg; }

async function refresh(): Promise<void> {
  const s = await loadSettings(api.storage);
  if (s.gatewayUrl) $<HTMLInputElement>("gateway").value = s.gatewayUrl;
  if (s.profileLabel) $<HTMLInputElement>("label").value = s.profileLabel;
  const signedIn = Boolean(s.token);
  $("status").textContent = signedIn ? `Signed in as ${s.binding ?? "unknown"} (${s.target?.kind === "pool" ? `pool ${s.target.pool}` : s.target ? `identity ${s.target.identity}` : "unbound"}).` : "Not signed in.";
  $<HTMLButtonElement>("signout").hidden = !signedIn;
  $<HTMLButtonElement>("signin").hidden = signedIn;
}

$("signin").addEventListener("click", async () => {
  setError("");
  cancel?.abort();
  const controller = new AbortController();
  cancel = controller;
  try {
    const url = await saveGatewayUrl(api.storage, $<HTMLInputElement>("gateway").value);
    const label = $<HTMLInputElement>("label").value.trim() || "Chrome profile";
    await api.storage.set({ profileLabel: label });
    const start = await startPairing(fetch, url, label);
    $("code").textContent = start.code;
    $("cmd-identity").textContent = `ais browser approve ${start.code} --identity=<id>`;
    $("cmd-pool").textContent = `ais browser approve ${start.code} --pool=<pool>`;
    $("pairing").hidden = false;
    await pollPairing({ fetch, storage: api.storage, signal: controller.signal }, url, start);
    $("pairing").hidden = true;
    await refresh();
  } catch (e) {
    $("pairing").hidden = true;
    setError(e instanceof Error ? e.message : "Sign-in failed");
  }
});

$("signout").addEventListener("click", async () => {
  await clearToken(api.storage);
  await refresh();
});

void refresh();
