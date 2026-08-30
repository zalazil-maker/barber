const CACHE = "barber-v17";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        ASSETS.map((a) =>
          c.add(a).catch(() => {
            /* skip failed precache entries */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Push notifications ──────────────────────────────────────────────────────
// Pushes carry no payload, so the details are fetched here. The admin code is
// left in the Cache by the app, because a service worker cannot read
// localStorage. If anything fails we still show a generic notification —
// never nothing, since the browser requires one.
const WORKER_URL = "https://barbershop.ezalazil.workers.dev";
const CFG_CACHE = "lb-cfg";
const ADMIN_KEY_URL = "/__lb/admin-key";

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

const SERVICE_LABELS = {
  cheveux: "Cheveux",
  barbe: "Barbe",
  both: "Cheveux + Barbe",
  enfant: "Enfant",
};

async function latestBookingText() {
  const cache = await caches.open(CFG_CACHE);
  const stored = await cache.match(ADMIN_KEY_URL);
  if (!stored) return null;
  const key = (await stored.text()).trim();
  if (!key) return null;

  const res = await fetch(
    `${WORKER_URL}/api/bookings?from=${isoPlus(0)}&to=${isoPlus(60)}&key=${encodeURIComponent(key)}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  const confirmed = (data.bookings || []).filter((b) => b.status === "confirmed");
  if (!confirmed.length) return null;

  confirmed.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const b = confirmed[0];
  const mins = Number(b.slot_min);
  const time =
    String(Math.floor(mins / 60)).padStart(2, "0") + "h" + String(mins % 60).padStart(2, "0");
  const service = SERVICE_LABELS[b.service] || b.service;
  return `${b.name} — ${b.slot_date} à ${time}\n${service} avec ${b.barber} · ${Number(b.price).toFixed(2)}€`;
}

self.addEventListener("push", (e) => {
  e.waitUntil(
    (async () => {
      let body = "Un client vient de réserver en ligne.";
      try {
        const detail = await latestBookingText();
        if (detail) body = detail;
      } catch (err) {
        /* fall back to the generic message */
      }
      await self.registration.showNotification("Nouveau rendez-vous", {
        body,
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        tag: "lb-rdv",
        renotify: true,
        data: { url: "./" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API/worker calls — always go to network for fresh data.
  if (url.hostname.endsWith(".workers.dev") || url.pathname.endsWith("/sql")) {
    return;
  }
  // Only handle our own origin static assets.
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML so updates roll out fast; cache-first for the rest.
  if (e.request.mode === "navigate" || url.pathname.endsWith(".html")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
    )
  );
});
