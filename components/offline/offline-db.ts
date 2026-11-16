/**
 * The device's offline copy in IndexedDB (offline wave A, 2026-11-16).
 * One database per origin: sessions + notes (keyPath id) and a small meta
 * store (last sync time). Plain IndexedDB — no dependency. Every call
 * opens, works, and closes; the copy is small and syncs are rare.
 */
import type { OfflineBundle, OfflineCopy, OfflineNoteDoc, OfflineSessionDoc } from "@/src/core";

const DB_NAME = "lh-offline";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const NOTES = "notes";
const META = "meta";

export interface OfflineMeta {
	/** ISO — the server's generatedAt of the last applied bundle. */
	lastSyncAt?: string;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("offline copy transaction aborted"));
	});
}

export function offlineDbAvailable(): boolean {
	return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "id" });
			if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: "id" });
			if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function withDb<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
	const db = await open();
	try { return await work(db); } finally { db.close(); }
}

export function loadOfflineCopy(): Promise<OfflineCopy> {
	return withDb(async (db) => {
		const tx = db.transaction([SESSIONS, NOTES], "readonly");
		const [sessions, notes] = await Promise.all([
			request(tx.objectStore(SESSIONS).getAll() as IDBRequest<OfflineSessionDoc[]>),
			request(tx.objectStore(NOTES).getAll() as IDBRequest<OfflineNoteDoc[]>),
		]);
		await done(tx);
		return { sessions: new Map(sessions.map((s) => [s.id, s])), notes: new Map(notes.map((n) => [n.id, n])) };
	});
}

/** Applies a bundle in ONE transaction (all of it or none of it). */
export function storeOfflineBundle(bundle: OfflineBundle): Promise<void> {
	return withDb(async (db) => {
		const tx = db.transaction([SESSIONS, NOTES, META], "readwrite");
		const sessions = tx.objectStore(SESSIONS);
		const notes = tx.objectStore(NOTES);
		for (const id of bundle.removedSessions) sessions.delete(id);
		for (const id of bundle.removedNotes) notes.delete(id);
		for (const doc of bundle.sessions) sessions.put(doc);
		for (const doc of bundle.notes) notes.put(doc);
		tx.objectStore(META).put(bundle.generatedAt, "lastSyncAt");
		await done(tx);
	});
}

export function loadOfflineMeta(): Promise<OfflineMeta> {
	return withDb(async (db) => {
		const tx = db.transaction(META, "readonly");
		const lastSyncAt = await request(tx.objectStore(META).get("lastSyncAt") as IDBRequest<string | undefined>);
		await done(tx);
		return lastSyncAt ? { lastSyncAt } : {};
	});
}

/** Wipes this device's offline copy (settings → Clear offline data). */
export function clearOfflineCopy(): Promise<void> {
	return withDb(async (db) => {
		const tx = db.transaction([SESSIONS, NOTES, META], "readwrite");
		tx.objectStore(SESSIONS).clear();
		tx.objectStore(NOTES).clear();
		tx.objectStore(META).clear();
		await done(tx);
	});
}
