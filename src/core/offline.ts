/**
 * THE OFFLINE COPY CONTRACT (offline wave A, owner 2026-11-16): a tablet
 * that loses its connection to the computer keeps a read-only copy of every
 * session (rendered as reading-mode markdown) and every imported-notes
 * snapshot. The device tells the server which revisions it holds; the
 * server answers with what changed and what disappeared.
 *
 * Pure: no framework imports. The server builds bundles
 * (src/server/offline-bundle.ts); the device applies them
 * (components/offline/offline-sync.ts) through applyOfflineBundle below.
 */
import type { ChatKind } from "./contracts/chat.ts";

/** One session as the offline view reads it. */
export interface OfflineSessionDoc {
	id: string;
	title: string;
	kind: ChatKind;
	createdAt: string;
	updatedAt: string;
	/** Opaque change stamp: a different rev means re-download. */
	rev: string;
	/** sessionMarkdown(..., { reading: true }) — the whole transcript. */
	markdown: string;
}

/** One imported-notes source as the offline view reads it. */
export interface OfflineNoteDoc {
	id: string;
	/** Display name (the user's rename, else the file name). */
	label: string;
	filePath: string;
	importedAt: string;
	rev: string;
	/** The import-time text snapshot; null = imported before snapshots
	 *  existed ("re-import to read offline"). */
	markdown: string | null;
}

/** What the device already holds: id → rev. */
export interface OfflineBundleRequest {
	sessions: Record<string, string>;
	notes: Record<string, string>;
}

/** The server's answer: new/changed docs in full, removed ids by name. */
export interface OfflineBundle {
	generatedAt: string;
	sessions: OfflineSessionDoc[];
	notes: OfflineNoteDoc[];
	removedSessions: string[];
	removedNotes: string[];
}

/** Upper bound on ids per kind in a request (a defensive parse cap). */
export const MAX_OFFLINE_KNOWN = 20_000;

/** Validates a device request. Malformed input throws (route → 400). */
export function parseOfflineBundleRequest(raw: unknown): OfflineBundleRequest {
	const obj = (raw ?? {}) as Record<string, unknown>;
	const known = (value: unknown, name: string): Record<string, string> => {
		if (value === undefined) return {};
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object of id → rev`);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > MAX_OFFLINE_KNOWN) throw new Error(`${name} lists too many ids`);
		const out: Record<string, string> = {};
		for (const [id, rev] of entries) {
			if (typeof rev !== "string") throw new Error(`${name}.${id} must be a string rev`);
			out[id] = rev;
		}
		return out;
	};
	return { sessions: known(obj.sessions, "sessions"), notes: known(obj.notes, "notes") };
}

/** The device's local copy (what IndexedDB holds, as plain maps). */
export interface OfflineCopy {
	sessions: Map<string, OfflineSessionDoc>;
	notes: Map<string, OfflineNoteDoc>;
}

/** The request a copy produces: every held id with its rev. */
export function offlineBundleRequestOf(copy: OfflineCopy): OfflineBundleRequest {
	return {
		sessions: Object.fromEntries([...copy.sessions.values()].map((s) => [s.id, s.rev])),
		notes: Object.fromEntries([...copy.notes.values()].map((n) => [n.id, n.rev])),
	};
}

/** Applies a bundle to a copy, returning a NEW copy (the input is untouched). */
export function applyOfflineBundle(copy: OfflineCopy, bundle: OfflineBundle): OfflineCopy {
	const sessions = new Map(copy.sessions);
	const notes = new Map(copy.notes);
	for (const id of bundle.removedSessions) sessions.delete(id);
	for (const id of bundle.removedNotes) notes.delete(id);
	for (const doc of bundle.sessions) sessions.set(doc.id, doc);
	for (const doc of bundle.notes) notes.set(doc.id, doc);
	return { sessions, notes };
}

/** Newest first — the offline lists' order (sessions by updatedAt, notes
 *  by importedAt). */
export function offlineSessionsInOrder(copy: OfflineCopy): OfflineSessionDoc[] {
	return [...copy.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function offlineNotesInOrder(copy: OfflineCopy): OfflineNoteDoc[] {
	return [...copy.notes.values()].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}
