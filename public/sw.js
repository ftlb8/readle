// Readle service worker: keeps the app itself (page, script, styles, icons)
// on the device so it opens without a connection. Saved articles are stored
// separately by the app, and requests to other sites are left alone.
const CACHE = "readle-shell-v1";

/** Downloads the current page and every file it references, then swaps them in. */
async function refreshShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch("./index.html", { cache: "no-cache" });
  if (!response.ok) return;
  const html = await response.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)].map((m) => m[1]);
  // Fetch the new files first, so a half-finished update never replaces a working copy.
  await Promise.all(
    assets.map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url);
    }),
  );
  await cache.put("./index.html", response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // Open instantly from the saved copy; pick up a newer version in the background.
    event.respondWith(
      caches.match("./index.html").then((cached) => cached ?? fetch(request)),
    );
    event.waitUntil(refreshShell().catch(() => {}));
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
