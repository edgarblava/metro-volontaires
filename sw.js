// Service worker : l'appli s'ouvre même hors connexion (les horaires, eux,
// viennent toujours du réseau). Réseau d'abord, cache en secours.
const CACHE = "metro-v6";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "stations.json",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // API et polices : pas de cache ici
  e.respondWith(
    // no-cache : revalide auprès du serveur, pour que les mises à jour arrivent tout de suite
    fetch(url.href, { cache: "no-cache" })
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
