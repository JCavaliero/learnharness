/**
 * Learning Harness service worker (offline wave A, 2026-11-16).
 *
 * Its one job: when the tablet cannot reach the computer, a page load still
 * opens the offline view (/offline), which reads the device's IndexedDB
 * copy. Nothing else is served from cache — API calls and online pages
 * always go to the network.
 *
 * - install / "refresh-shell" message: fetch /offline, cache its HTML and
 *   every same-origin <script src> / <link href> it names (hashed build
 *   assets, the manifest, icons). A new build's asset list replaces the old.
 * - navigations: network first; on failure, redirect to /offline (served
 *   from cache) so the router hydrates at the right URL.
 * - /_next/static/* and /fonts/*: cache first, filled on use, so lazily
 *   loaded chunks and fonts seen online also work offline.
 *
 * Registered only in production builds (components/offline/offline-client.tsx).
 */
const VERSION = "lh-offline-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = "/offline";

/** Same-origin asset paths named by <script src> and <link href> tags. */
function assetUrlsOf(html, origin) {
	const urls = new Set();
	const tag = /<(script|link)\b[^>]*>/gi;
	let match;
	while ((match = tag.exec(html)) !== null) {
		const attr = match[1].toLowerCase() === "script" ? "src" : "href";
		const value = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(match[0]);
		const raw = value && (value[1] ?? value[2]);
		if (!raw) continue;
		let url;
		try { url = new URL(raw.replace(/&amp;/g, "&"), origin); } catch { continue; }
		if (url.origin !== origin || url.pathname.startsWith("/api/")) continue;
		urls.add(url.pathname + url.search);
	}
	return [...urls];
}

async function cacheShell() {
	const res = await fetch(OFFLINE_URL, { cache: "no-store", credentials: "same-origin" });
	if (!res.ok) throw new Error(`offline shell fetch failed: ${res.status}`);
	const html = await res.clone().text();
	const assets = assetUrlsOf(html, self.location.origin);
	const shell = await caches.open(SHELL_CACHE);
	const fetched = await Promise.all(assets.map(async (url) => {
		try {
			const asset = await fetch(url, { credentials: "same-origin" });
			return asset.ok ? [url, asset] : null;
		} catch { return null; }
	}));
	// Replace the shell wholesale: the previous build's assets go.
	const previous = new Set();
	for (const key of await shell.keys()) {
		const u = new URL(key.url);
		if (u.pathname !== OFFLINE_URL) previous.add(u.pathname + u.search);
		await shell.delete(key);
	}
	await shell.put(OFFLINE_URL, res);
	for (const entry of fetched) if (entry) await shell.put(entry[0], entry[1]);
	// A different asset list means a new build: the runtime static cache
	// holds the old build's chunks — drop it (it re-fills on online use).
	const scripts = (list) => [...list].filter((u) => u.startsWith("/_next/static/")).sort().join("\n");
	if (previous.size > 0 && scripts(previous) !== scripts(assets)) await caches.delete(STATIC_CACHE);
}

self.addEventListener("install", (event) => {
	event.waitUntil(cacheShell().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		for (const name of await caches.keys()) if (!name.startsWith(VERSION)) await caches.delete(name);
		await self.clients.claim();
	})());
});

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "refresh-shell") event.waitUntil(cacheShell().catch(() => {}));
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

	if (req.mode === "navigate") {
		event.respondWith((async () => {
			try { return await fetch(req); }
			catch (err) {
				if (url.pathname === OFFLINE_URL) {
					const cached = await caches.match(OFFLINE_URL);
					if (cached) return cached;
					throw err;
				}
				if (await caches.match(OFFLINE_URL)) return Response.redirect(new URL(OFFLINE_URL, self.location.origin).href, 302);
				throw err;
			}
		})());
		return;
	}

	const shellHit = (async () => (await caches.open(SHELL_CACHE)).match(url.pathname + url.search))();
	// Hashed build assets, plus the bundled fonts (public/fonts — changed
	// only with a VERSION bump), are cache-first.
	if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/")) {
		event.respondWith((async () => {
			const hit = (await shellHit) ?? (await caches.match(req));
			if (hit) return hit;
			const res = await fetch(req);
			if (res.ok) {
				const copy = res.clone();
				event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.put(req, copy)));
			}
			return res;
		})());
		return;
	}

	// Other shell assets (manifest, icons): network first, cache fallback.
	event.respondWith((async () => {
		try { return await fetch(req); }
		catch (err) {
			const hit = await shellHit;
			if (hit) return hit;
			throw err;
		}
	})());
});

// Test seam: node tests evaluate this file in a sandbox and read it back.
if (typeof self.__lhSwTest === "object" && self.__lhSwTest !== null) self.__lhSwTest.assetUrlsOf = assetUrlsOf;
