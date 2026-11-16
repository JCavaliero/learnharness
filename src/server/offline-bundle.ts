/**
 * Builds the offline copy delta (offline wave A, 2026-11-16) — see
 * src/core/offline.ts for the contract. Sessions render through the one
 * markdown engine in reading mode; notes come from the import-time text
 * snapshots. Revs are content-free stamps: a session's changes whenever its
 * title, kind or updatedAt does (renames do not bump updatedAt, so the
 * title is part of the stamp); a note's when its name, path, import time or
 * snapshot presence does.
 */
import { createHash } from "node:crypto";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { practiceItemsOf, recordedAttemptsOf, type AttemptRecord } from "../core/offline-practice.ts";
import { packItemsOf, packSummaries } from "../core/offline-packs.ts";
import type { OfflineBundle, OfflineBundleRequest, OfflineNoteDoc, OfflineSessionDoc } from "../core/offline.ts";
import type { ChatStore, SourceTextStore } from "../core/ports.ts";
import type { SourceDirectory } from "../core/source-organization.ts";

/** Engine version folded into every rev: bump when the reading markdown
 *  changes shape, so devices re-download everything once. */
const OFFLINE_RENDER_VERSION = "3"; // 2: practice items + recorded attempts (wave B); 3: packs (wave C)

function stamp(parts: readonly string[]): string {
	return createHash("sha256").update([OFFLINE_RENDER_VERSION, ...parts].join("\u0000")).digest("hex").slice(0, 16);
}

export interface OfflineBundleDeps {
	chatStore: Pick<ChatStore, "listChats" | "getChat">;
	sourceTextStore: Pick<SourceTextStore, "read">;
	readSourceDirectory: () => SourceDirectory;
	/** Wave B: attempts on the server not yet in a history. */
	pendingAttempts?: () => AttemptRecord[];
	now?: () => Date;
}

export function buildOfflineBundle(known: OfflineBundleRequest, deps: OfflineBundleDeps): OfflineBundle {
	const sessions: OfflineSessionDoc[] = [];
	const liveSessions = new Set<string>();
	for (const summary of deps.chatStore.listChats()) {
		liveSessions.add(summary.id);
		const rev = stamp([summary.title, summary.kind, summary.updatedAt, summary.offlinePacksRev ?? ""]);
		if (known.sessions[summary.id] === rev) continue;
		const record = deps.chatStore.getChat(summary.id);
		if (!record) { liveSessions.delete(summary.id); continue; }
		sessions.push({
			id: summary.id,
			title: summary.title,
			kind: summary.kind,
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
			rev,
			markdown: sessionMarkdown(record.messages, { title: record.title, anchors: false, reading: true }),
			practice: [...practiceItemsOf(summary.id, record.messages), ...packItemsOf(record.offlinePacks)],
			attempts: recordedAttemptsOf(summary.id, record.messages),
			packs: packSummaries(summary.id, record.offlinePacks),
		});
	}

	const notes: OfflineNoteDoc[] = [];
	const liveNotes = new Set<string>();
	for (const entry of deps.readSourceDirectory().sources) {
		if (entry.kind !== "notes") continue;
		liveNotes.add(entry.id);
		const text = deps.sourceTextStore.read(entry.id);
		const label = entry.label ?? entry.filePath ?? entry.id;
		const filePath = entry.filePath ?? "";
		const importedAt = entry.createdAt ?? "";
		const rev = stamp([label, filePath, importedAt, text === null ? "absent" : "present"]);
		if (known.notes[entry.id] === rev) continue;
		notes.push({ id: entry.id, label, filePath, importedAt, rev, markdown: text });
	}

	return {
		generatedAt: (deps.now?.() ?? new Date()).toISOString(),
		sessions,
		notes,
		removedSessions: Object.keys(known.sessions).filter((id) => !liveSessions.has(id)),
		removedNotes: Object.keys(known.notes).filter((id) => !liveNotes.has(id)),
		pendingAttempts: deps.pendingAttempts?.() ?? [],
	};
}
