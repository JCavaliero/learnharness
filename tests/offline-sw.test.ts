/**
 * SERVICE WORKER PINS (offline wave A, 2026-11-16): public/sw.js runs in a
 * vm sandbox with fake caches/fetch. Pins the asset scan, the shell cache,
 * the navigation fallback (redirect to /offline when the network fails),
 * API pass-through, and cache-first static assets.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

const SOURCE = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://tablet.example";

class FakeCache {
	entries = new Map<string, Response>();
	key(req: Request | string) { const u = new URL(typeof req === "string" ? req : req.url, ORIGIN); return u.pathname + u.search; }
	async match(req: Request | string) { const hit = this.entries.get(this.key(req)); return hit?.clone(); }
	async put(req: Request | string, res: Response) { this.entries.set(this.key(req), res); }
	async delete(req: Request | string) { return this.entries.delete(this.key(req)); }
	async keys() { return [...this.entries.keys()].map((k) => new Request(ORIGIN + k)); }
}

function load(fetchImpl: (url: string) => Promise<Response>) {
	const named = new Map<string, FakeCache>();
	const caches = {
		open: async (name: string) => { if (!named.has(name)) named.set(name, new FakeCache()); return named.get(name)!; },
		keys: async () => [...named.keys()],
		delete: async (name: string) => named.delete(name),
		match: async (req: Request | string) => { for (const c of named.values()) { const hit = await c.match(req); if (hit) return hit; } return undefined; },
	};
	const listeners = new Map<string, (event: unknown) => void>();
	const test: { assetUrlsOf?: (html: string, origin: string) => string[] } = {};
	const self = {
		location: { origin: ORIGIN },
		addEventListener: (type: string, cb: (event: unknown) => void) => listeners.set(type, cb),
		skipWaiting: async () => {},
		clients: { claim: async () => {} },
		__lhSwTest: test,
	};
	const fetch = async (input: Request | string) => fetchImpl(new URL(typeof input === "string" ? input : input.url, ORIGIN).href);
	vm.runInNewContext(SOURCE, { self, caches, fetch, URL, Response, Request, Set, Promise, Error, RegExp });
	async function dispatch(type: string, data: Record<string, unknown>) {
		const waits: Promise<unknown>[] = [];
		let responded: Promise<Response> | undefined;
		listeners.get(type)!({ ...data, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => { responded = p; } });
		await Promise.all(waits);
		return responded;
	}
	return { named, dispatch, test };
}

const SHELL_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/_next/static/css/app.css"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<script src="/_next/static/chunks/main.js" async=""></script>
<script src='https://cdn.elsewhere.example/x.js'></script>
<link rel="preload" href="/api/should-not-cache"/>
</head><body></body></html>`;

describe("service worker", () => {
	it("scans same-origin script/link assets and skips foreign + API urls", () => {
		const { test } = load(async () => new Response(""));
		assert.deepEqual([...test.assetUrlsOf!(SHELL_HTML, ORIGIN)], ["/_next/static/css/app.css", "/manifest.webmanifest", "/_next/static/chunks/main.js"]);
	});

	it("install caches /offline and its assets; offline navigations redirect to /offline, which is served from cache", async () => {
		let online = true;
		const sw = load(async (url) => {
			if (!online) throw new TypeError("network down");
			if (url.endsWith("/offline")) return new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
			return new Response(`asset ${url}`);
		});
		await sw.dispatch("install", {});
		const shell = sw.named.get("lh-offline-v1-shell")!;
		assert.deepEqual([...shell.entries.keys()].sort(), ["/_next/static/chunks/main.js", "/_next/static/css/app.css", "/manifest.webmanifest", "/offline"]);

		online = false;
		const nav = await sw.dispatch("fetch", { request: { method: "GET", url: `${ORIGIN}/chat/abc`, mode: "navigate" } });
		const redirect = await nav!;
		assert.equal(redirect.status, 302);
		assert.equal(new URL(redirect.headers.get("location")!, ORIGIN).pathname, "/offline");

		const offlineNav = await (await sw.dispatch("fetch", { request: { method: "GET", url: `${ORIGIN}/offline`, mode: "navigate" } }))!;
		assert.match(await offlineNav.text(), /<!doctype html>/);

		const chunk = await (await sw.dispatch("fetch", { request: new Request(`${ORIGIN}/_next/static/chunks/main.js`) }))!;
		assert.equal(await chunk.text(), `asset ${ORIGIN}/_next/static/chunks/main.js`);
	});

	it("API requests and non-GETs are never intercepted", async () => {
		const sw = load(async () => new Response("x"));
		assert.equal(await sw.dispatch("fetch", { request: { method: "GET", url: `${ORIGIN}/api/chats`, mode: "cors" } }), undefined);
		assert.equal(await sw.dispatch("fetch", { request: { method: "POST", url: `${ORIGIN}/offline`, mode: "navigate" } }), undefined);
	});

	it("static assets fill the runtime cache on first use and are then served cache-first", async () => {
		let calls = 0;
		const sw = load(async (url) => { calls++; return new Response(`v${calls} ${url}`); });
		const req = () => new Request(`${ORIGIN}/_next/static/chunks/lazy.js`);
		const first = await (await sw.dispatch("fetch", { request: req() }))!;
		assert.equal(await first.text(), `v1 ${ORIGIN}/_next/static/chunks/lazy.js`);
		const second = await (await sw.dispatch("fetch", { request: req() }))!;
		assert.equal(await second.text(), `v1 ${ORIGIN}/_next/static/chunks/lazy.js`, "served from cache");
		assert.equal(calls, 1);
	});
});
