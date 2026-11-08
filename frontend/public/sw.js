/*
 * Service worker of the customer menu: the offline copy (step 9). MenuView registers it with the
 * scope /menu/, so it never controls the dashboards, /login or the BFF routes.
 * - Menu pages: network first. A customer who is online always gets the current menu; the last
 *   copy of each menu is kept, so it still opens without a connection. A page streams with status
 *   200 even when its rendering fails later, so a new copy waits in PENDING until the menu on it
 *   reports that it rendered ("keep" below); only then does it replace the kept copy.
 * - /_next/static files: cache first. Their names contain a hash of their content, so a file with
 *   the same name never changes.
 * - Everything else (R2 images, the manifest, POSTs) goes to the network as usual.
 * - After each visit the page reports the files it loaded. The worker remembers them per menu and
 *   deletes every file that no kept menu uses, so the cache does not grow with each deploy.
 * Change VERSION when these caching rules change: the caches of the old version are then deleted.
 */
const VERSION = "v2";
const PAGES = `menu-pages-${VERSION}`;
const FILES = `menu-files-${VERSION}`;
const USES = `menu-uses-${VERSION}`; // per kept menu: the JSON list of the files it needs
const PENDING = `menu-pending-${VERSION}`; // per menu: the copy of the last visit, not yet confirmed

self.addEventListener("install", () => {
  self.skipWaiting(); // a new version takes over at once, without waiting for menu tabs to close
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("menu-") && ![PAGES, FILES, USES, PENDING].includes(name)) {
          await caches.delete(name);
        }
      }
      await self.clients.claim(); // control the menu page that registered this worker, too
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  if (event.request.mode === "navigate" && url.pathname.startsWith("/menu/")) {
    event.respondWith(networkFirst(event, url));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(event));
  }
});

// One copy per menu, without ?table=N: the page reads the table number in the browser.
const pageKey = (url) => url.origin + url.pathname;

// Per menu: the save into PENDING that is still running. The page's "keep" message often arrives
// before the streamed page has been copied completely, so keep() waits for it.
const saving = new Map();

async function networkFirst(event, url) {
  // An unconfirmed copy of an earlier visit (an error page) must never be confirmed by this visit.
  const key = pageKey(url);
  const cleared = caches.open(PENDING).then((cache) => cache.delete(key));
  saving.set(key, cleared);
  event.waitUntil(cleared);
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      // Saved in the background, so the page still streams to the customer while it is copied.
      const copy = response.clone();
      const saved = cleared.then(() => caches.open(PENDING)).then((cache) => cache.put(key, copy));
      saving.set(key, saved.catch(() => {}));
      event.waitUntil(saved);
    }
    return response;
  } catch (error) {
    const copy = await caches.match(pageKey(url), { cacheName: PAGES });
    if (copy) {
      return copy;
    }
    throw error; // a menu never opened before: the browser shows its usual offline page
  }
}

async function cacheFirst(event) {
  const cached = await caches.match(event.request, { cacheName: FILES });
  if (cached) {
    return cached;
  }
  const response = await fetch(event.request);
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(caches.open(FILES).then((cache) => cache.put(event.request, copy)));
  }
  return response;
}

// After every visit MenuView sends the page address and the /_next/static files it loaded. On the
// first visit the page and its files loaded before this worker existed, so they are fetched here,
// and even that first visit can be opened offline later.
self.addEventListener("message", (event) => {
  if (event.data?.type === "keep") {
    event.waitUntil(keep(event.data.page, event.data.files));
  } else if (event.data?.type === "forget") {
    event.waitUntil(forget(event.data.page));
  }
});

// The menu is not found or unavailable now (notice.tsx): its old copy must not open offline.
async function forget(page) {
  const pageUrl = new URL(page);
  for (const name of [PAGES, USES, PENDING]) {
    await (await caches.open(name)).delete(pageKey(pageUrl));
  }
}

async function keep(page, files) {
  const pageUrl = new URL(page);
  if (pageUrl.origin !== self.location.origin || !pageUrl.pathname.startsWith("/menu/")) {
    return;
  }
  await saving.get(pageKey(pageUrl));
  const pages = await caches.open(PAGES);
  const pending = await caches.open(PENDING);
  const confirmed = await pending.match(pageKey(pageUrl));
  if (confirmed) {
    // The menu rendered: this visit's copy replaces the kept one.
    await pages.put(pageKey(pageUrl), confirmed);
    await pending.delete(pageKey(pageUrl));
  } else if (!(await pages.match(pageKey(pageUrl)))) {
    const response = await fetch(pageKey(pageUrl));
    if (response.ok) {
      await pages.put(pageKey(pageUrl), response);
    }
  }
  const used = (Array.isArray(files) ? files : [])
    .map((file) => new URL(file))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"))
    .map((url) => url.href);
  const fileCache = await caches.open(FILES);
  for (const href of used) {
    if (!(await fileCache.match(href))) {
      await fileCache.add(href);
    }
  }
  await (await caches.open(USES)).put(pageKey(pageUrl), Response.json(used));
  await prune(pages, fileCache);
}

// Deletes the files that no kept menu needs, for example those of an earlier deploy. A menu kept
// before its list was recorded is unknown, so nothing is deleted until every kept menu has a list.
async function prune(pages, fileCache) {
  const uses = await caches.open(USES);
  const needed = new Set();
  for (const request of await pages.keys()) {
    const list = await uses.match(request.url);
    if (!list) {
      return;
    }
    for (const href of await list.json()) {
      needed.add(href);
    }
  }
  for (const request of await fileCache.keys()) {
    if (!needed.has(request.url)) {
      await fileCache.delete(request);
    }
  }
}
