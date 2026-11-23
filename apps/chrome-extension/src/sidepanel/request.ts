// Popup page: shows one pending request with Approve and Deny. The worker opens it when the side panel cannot open.
import { initRequests } from "./requests.ts";

const root = document.getElementById("requests");
const id = new URLSearchParams(location.search).get("id") ?? "";
if (root && typeof chrome !== "undefined" && chrome.runtime?.id) {
  const ended = document.getElementById("ended");
  initRequests(root, { only: id, onEmpty: () => { ended?.removeAttribute("hidden"); setTimeout(() => window.close(), 1200); } });
}
