/*
 * Service worker of the customer menu: the offline copy (step 9). MenuView registers it with the
 * scope /menu/, so it never controls the dashboards, /login or the BFF routes.
 * - Menu pages: network first. A customer who is online always gets the current menu; the last
 *   copy of each menu is kept, so it still opens without a connection.
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

self.addEventListener("install", () => {
  self.skipWaiting(); // a new version takes over at once, without waiting for menu tabs to close
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("menu-") && ![PAGES, FILES, USES].includes(name)) {
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

async function networkFirst(event, url) {
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      // Saved in the background, so the page still streams to the customer while it is copied.
      const copy = response.clone();
      event.waitUntil(caches.open(PAGES).then((cache) => cache.put(pageKey(url), copy)));
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
  }
});

async function keep(page, files) {
  const pageUrl = new URL(page);
  if (pageUrl.origin !== self.location.origin || !pageUrl.pathname.startsWith("/menu/")) {
    return;
  }
  const pages = await caches.open(PAGES);
  if (!(await pages.match(pageKey(pageUrl)))) {
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
