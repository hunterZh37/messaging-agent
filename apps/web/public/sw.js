/* Celeste's service worker (2026-09-14): shows what the Mac pushes, and opens
   the thread when the notification is tapped. Nothing is cached: Celeste is
   only useful with the Mac reachable. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Celeste", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Celeste", {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "/icons/192",
      badge: "/icons/192",
      data: { url: data.url || "/inbox?status=needs_reply" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.location.origin));
      if (open) return open.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : undefined));
      return self.clients.openWindow(url);
    }),
  );
});
