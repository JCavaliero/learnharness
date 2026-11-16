/**
 * Offline copy sync + reachability (offline wave A, 2026-11-16).
 *
 * syncOfflineCopy() sends the revs the device holds to
 * POST /api/offline/bundle and stores the delta. It is single-flight (a
 * call while one runs joins it). A network failure marks the server
 * unreachable — the banner's and the offline view's signal; any success
 * marks it reachable again.
 *
 * The status lives in a tiny module store (useSyncExternalStore) so the
 * banner, the settings section and the offline view read one truth.
 */
import { useSyncExternalStore } from "react";
import { applyOfflineBundle, offlineBundleRequestOf, type OfflineBundle } from "@/src/core";
import { listLocalAttempts, loadOfflineCopy, loadOfflineMeta, offlineDbAvailable, storeOfflineBundle, updateLocalAttempts } from "./offline-db";

export interface OfflineStatus {
	/** null = not yet known (no attempt finished). */
	reachable: boolean | null;
	syncing: boolean;
	lastSyncAt: string | null;
	/** A non-network failure (server error, storage error). */
	error: string | null;
	/** Bumps whenever the stored copy changed — views reload on it. */
	copyVersion: number;
}

let status: OfflineStatus = { reachable: null, syncing: false, lastSyncAt: null, error: null, copyVersion: 0 };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<OfflineStatus>): void {
	status = { ...status, ...patch };
	for (const listener of listeners) listener();
}

export function getOfflineStatus(): OfflineStatus {
	return status;
}

export function subscribeOfflineStatus(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const SERVER_SNAPSHOT = status;
export function useOfflineStatus(): OfflineStatus {
	return useSyncExternalStore(subscribeOfflineStatus, getOfflineStatus, () => SERVER_SNAPSHOT);
}

/** Marks the server unreachable without a request (the browser's own
 *  `offline` event). */
export function markUnreachable(): void {
	if (status.reachable !== false) setStatus({ reachable: false });
}

/** Seeds lastSyncAt from storage once (the offline view opens cold). */
let metaLoaded = false;
export async function loadOfflineStatusMeta(): Promise<void> {
	if (metaLoaded || !offlineDbAvailable()) return;
	metaLoaded = true;
	try {
		const meta = await loadOfflineMeta();
		if (meta.lastSyncAt && !status.lastSyncAt) setStatus({ lastSyncAt: meta.lastSyncAt });
	} catch { /* storage unavailable: the status just stays empty */ }
}

let inFlight: Promise<void> | null = null;

export function syncOfflineCopy(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<void> {
	if (inFlight) return inFlight;
	if (!offlineDbAvailable()) return Promise.resolve();
	inFlight = (async () => {
		setStatus({ syncing: true });
		try {
			// Upload answers first, so the bundle that follows lists them.
			const uploaded = await uploadAttempts(fetchImpl);
			if (uploaded === "unreachable") { setStatus({ reachable: false }); return; }
			const copy = await loadOfflineCopy();
			let res: Response;
			try {
				res = await fetchImpl("/api/offline/bundle", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(offlineBundleRequestOf(copy)),
					cache: "no-store",
				});
			} catch {
				setStatus({ reachable: false });
				return;
			}
			if (!res.ok) {
				setStatus({ reachable: true, error: `Offline sync failed (${res.status}).` });
				return;
			}
			const bundle = (await res.json()) as OfflineBundle;
			const changed = bundle.sessions.length + bundle.notes.length + bundle.removedSessions.length + bundle.removedNotes.length > 0;
			// The pure apply is the contract the store mirrors; running it
			// first keeps a malformed bundle from reaching storage.
			applyOfflineBundle(copy, bundle);
			await storeOfflineBundle(bundle);
			// Answers the server now lists are its to keep: drop the local copies.
			const held = new Set([...(bundle.pendingAttempts ?? []), ...bundle.sessions.flatMap((s) => s.attempts ?? [])].map((a) => a.id));
			const local = await listLocalAttempts();
			const drop = local.filter((a) => a.uploaded && held.has(a.id)).map((a) => a.id);
			if (drop.length > 0) await updateLocalAttempts([], drop);
			setStatus({
				reachable: true,
				error: null,
				lastSyncAt: bundle.generatedAt,
				...(changed ? { copyVersion: status.copyVersion + 1 } : {}),
			});
		} catch (err) {
			setStatus({ error: err instanceof Error ? err.message : String(err) });
		} finally {
			setStatus({ syncing: false });
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Sends answers not uploaded yet. Rejected ones (their item or session is
 *  gone) are dropped — they can never be recorded. */
async function uploadAttempts(fetchImpl: typeof fetch): Promise<"ok" | "unreachable" | "failed"> {
	const pending = (await listLocalAttempts()).filter((a) => !a.uploaded);
	if (pending.length === 0) return "ok";
	let res: Response;
	try {
		res = await fetchImpl("/api/offline/attempts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ attempts: pending.map(({ uploaded: _uploaded, ...a }) => a) }),
			cache: "no-store",
		});
	} catch { return "unreachable"; }
	if (!res.ok) { setStatus({ error: `Uploading offline answers failed (${res.status}).` }); return "failed"; }
	const { accepted, rejected } = (await res.json()) as { accepted: string[]; rejected: { id: string; reason: string }[] };
	await updateLocalAttempts(accepted, rejected.map((r) => r.id));
	if (rejected.length > 0) console.warn("[offline] answers the server could not record:", rejected);
	setStatus({ copyVersion: status.copyVersion + 1 });
	return "ok";
}

/** After "Clear offline data": the views must forget what they showed. */
export function noteOfflineCopyCleared(): void {
	setStatus({ lastSyncAt: null, copyVersion: status.copyVersion + 1 });
}

/** A local answer was saved: views reload their attempt lists. */
export function noteOfflineCopyChanged(): void {
	setStatus({ copyVersion: status.copyVersion + 1 });
}
