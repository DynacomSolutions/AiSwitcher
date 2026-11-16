// AIS Console service worker: makes the console installable as a PWA.
// It caches nothing. Every request goes to the network as usual, so the
// console stays a live view and no API data or token is ever stored here.
// Only a failed page navigation is answered, with a small offline page.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AIS Console (offline)</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0b19;color:#eeedf3;font:15px system-ui,sans-serif}
main{text-align:center;padding:24px}button{margin-top:16px;padding:8px 16px;border:0;border-radius:8px;background:#9776fb;color:#0e0b19;font:inherit;cursor:pointer}</style>
</head><body><main><h1>AIS Console is offline</h1><p>The console server cannot be reached.</p>
<button onclick="location.reload()">Retry</button></main></body></html>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
    ),
  );
});
