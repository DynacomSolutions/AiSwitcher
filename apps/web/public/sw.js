// AIS Console service worker: makes the console installable as a PWA.
// It caches nothing. Every request goes to the network as usual, so the
// console stays a live view and no API data or token is ever stored here.
// Only a failed page navigation is answered, with a small offline page.
// It also shows push notifications (reset-expiry reminders) and opens the
// console when one is tapped.

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

// Push reminders from the console daemon (reset expiry). The payload is
// { title, body, tag, url }; the server encrypts it for this browser only.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "AIS Console";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.navigate(url).then((c) => (c ?? client).focus());
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
