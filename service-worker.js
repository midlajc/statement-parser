const APP_CACHE = "stmt-tools-app-v7";
const SHARE_CACHE = "stmt-tools-share-v1";
const PENDING_META_KEY = "/__shared__/pending.json";

const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-1024.png",
  "/icons/apple-touch-icon-180.png",
  "/parsers/hdfc-credit-card.js",
  "/parsers/hdfc-bank.js",
  "/parsers/hdfc-bank-pdf.js",
  "/parsers/rbl-bank.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      await cache.addAll(APP_SHELL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== APP_CACHE && key !== SHARE_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  if (event.request.method === "GET" && url.pathname === "/shared-files/pending") {
    event.respondWith(getPendingShare());
    return;
  }

  if (event.request.method === "GET" && url.pathname === "/shared-files/consume") {
    event.respondWith(consumePendingShare(url.searchParams.get("id")));
    return;
  }

  if (event.request.method === "GET" && url.pathname.startsWith("/__shared__/")) {
    event.respondWith(getSharedFile(url.pathname));
    return;
  }

  if (event.request.method !== "GET") {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(handleNavigate(event.request));
    return;
  }

  event.respondWith(handleStatic(event.request));
});

async function handleNavigate(request) {
  const cache = await caches.open(APP_CACHE);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put("/index.html", response.clone());
    }
    return response;
  } catch (_error) {
    const fallback = await cache.match("/index.html");
    if (fallback) {
      return fallback;
    }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function handleStatic(request) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    return new Response("Not available offline", { status: 503, statusText: "Offline" });
  }
}

async function handleShareTarget(request) {
  const formData = await request.formData();
  const allEntries = formData.getAll("pdfs");
  const files = allEntries.filter(
    (entry) => entry instanceof File && isPdfFile(entry),
  );

  const shareCache = await caches.open(SHARE_CACHE);
  await clearPendingShare(shareCache);

  if (!files.length) {
    return Response.redirect("/?shared=empty", 303);
  }

  const shareId = Date.now().toString(36);
  const metadata = {
    id: shareId,
    createdAt: new Date().toISOString(),
    files: [],
  };

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const safeName = file.name || `statement-${index + 1}.pdf`;
    const url = `/__shared__/file-${shareId}-${index}.pdf`;
    const headers = {
      "Content-Type": file.type || "application/pdf",
      "Cache-Control": "no-store",
      "X-Shared-File-Name": encodeURIComponent(safeName),
    };

    await shareCache.put(url, new Response(file, { headers }));

    metadata.files.push({
      name: safeName,
      type: file.type || "application/pdf",
      size: file.size,
      url,
    });
  }

  await shareCache.put(
    PENDING_META_KEY,
    new Response(JSON.stringify(metadata), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }),
  );

  return Response.redirect("/?shared=1", 303);
}

async function getPendingShare() {
  const shareCache = await caches.open(SHARE_CACHE);
  const response = await shareCache.match(PENDING_META_KEY);

  if (!response) {
    return new Response("", { status: 204, statusText: "No Content" });
  }

  return new Response(await response.text(), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function consumePendingShare(id) {
  const shareCache = await caches.open(SHARE_CACHE);
  const response = await shareCache.match(PENDING_META_KEY);

  if (!response) {
    return new Response("", { status: 204, statusText: "No Content" });
  }

  const metadata = await response.json();

  if (id && metadata.id && metadata.id !== id) {
    return new Response("Mismatched share id", { status: 409, statusText: "Conflict" });
  }

  for (const file of metadata.files || []) {
    if (file?.url) {
      await shareCache.delete(file.url);
    }
  }
  await shareCache.delete(PENDING_META_KEY);

  return new Response("", { status: 204, statusText: "No Content" });
}

async function clearPendingShare(cache) {
  const existing = await cache.match(PENDING_META_KEY);
  if (!existing) {
    return;
  }

  const metadata = await existing.json();
  for (const file of metadata.files || []) {
    if (file?.url) {
      await cache.delete(file.url);
    }
  }
  await cache.delete(PENDING_META_KEY);
}

async function getSharedFile(pathname) {
  const shareCache = await caches.open(SHARE_CACHE);
  const response = await shareCache.match(pathname);

  if (!response) {
    return new Response("Not found", { status: 404, statusText: "Not Found" });
  }

  return response;
}

function isPdfFile(file) {
  const mimeType = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return mimeType === "application/pdf" || name.endsWith(".pdf");
}
