/**
 * Offline practice packs on the server (offline wave C, owner 2026-11-16).
 *
 * start(chatId) runs the strong-tier pack author in the background over the
 * session's material — its reading transcript, the propositions it covers
 * (graph provenance + any graph-context picks), the chains among picked
 * propositions, and everything already asked (replay items + earlier
 * packs). The finished pack is stored on the session record; its usage
 * lands in the session's cost log. Runs show in the activity dock (one row
 * each, abortable); a failed run stays two minutes with its error.
 *
 * remove(chatId, packId) deletes a pack's unanswered items (owner).
 */
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ChatStore } from "../core/ports.ts";
import type { CallUsage } from "../core/contracts/chat.ts";
import type { GraphNode } from "../core/contracts/graph.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { practiceItemsOf } from "../core/offline-practice.ts";
import { deletePack, packFromDraft, packItemsOf, type OfflinePack, type PackDraftItem } from "../core/offline-packs.ts";
import type { PackMaterial } from "../agent/subagents/pack-author.ts";

const FAILED_ROW_MS = 2 * 60_000;

export interface PackRun {
	id: string;
	chatId: string;
	title: string;
	startedAt: number;
	status: "running" | "failed";
	error?: string;
	controller: AbortController;
	model?: string;
	steps: number;
}

export interface OfflinePacksDeps {
	chatStore: Pick<ChatStore, "getChat" | "updateOfflinePacks" | "appendTurnUsage">;
	graphNodes: () => readonly GraphNode[];
	write: (material: PackMaterial, chatId: string, signal: AbortSignal, onStep: (usage: Usage, model: string) => void) => Promise<PackDraftItem[]>;
	toCallUsage: (usage: Usage) => CallUsage;
	/** Item keys with any attempt (recorded or pending) — kept on delete. */
	answeredKeys: (chatId: string) => ReadonlySet<string>;
	notify: (chatId: string) => void;
	activityChanged: () => void;
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => unknown;
}

export class PackStartError extends Error {
	constructor(message: string, public status: number) { super(message); }
}

export function packMaterialOf(chatId: string, record: NonNullable<ReturnType<ChatStore["getChat"]>>, nodes: readonly GraphNode[]): PackMaterial {
	const propositions = new Map<string, { id: string; name: string; statement: string }>();
	const chains: string[] = [];
	for (const m of record.messages) {
		if (m.role !== "custom" || m.customType !== "graph-context") continue;
		const d = m.details as { propositions?: { id: string; name: string; statement: string }[]; chains?: string[] } | null;
		for (const p of d?.propositions ?? []) propositions.set(p.id, { id: p.id, name: p.name, statement: p.statement });
		chains.push(...(d?.chains ?? []));
	}
	for (const n of nodes) {
		if (n.provenance.some((p) => p.chatId === chatId)) propositions.set(n.id, { id: n.id, name: n.name, statement: n.statement });
	}
	const asked = [...practiceItemsOf(chatId, record.messages), ...packItemsOf(record.offlinePacks)]
		.map((i) => (i.kind === "quiz" ? i.question : i.statement));
	return {
		transcript: sessionMarkdown(record.messages, { anchors: false, reading: true }),
		propositions: [...propositions.values()],
		chains,
		asked,
	};
}

export function createOfflinePacks(deps: OfflinePacksDeps) {
	const now = deps.now ?? Date.now;
	const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
	const runs = new Map<string, PackRun>();

	function start(chatId: string): PackRun {
		const record = deps.chatStore.getChat(chatId);
		if (!record) throw new PackStartError("Session not found", 404);
		for (const r of runs.values()) if (r.chatId === chatId && r.status === "running") throw new PackStartError("A pack is already being made for this session", 409);
		const run: PackRun = {
			id: `pack_${randomUUID().replace(/-/g, "")}`,
			chatId,
			title: record.title,
			startedAt: now(),
			status: "running",
			controller: new AbortController(),
			steps: 0,
		};
		runs.set(run.id, run);
		deps.activityChanged();
		const usage: { model: string; step: CallUsage }[] = [];
		const material = packMaterialOf(chatId, record, deps.graphNodes());
		void (async () => {
			const packId = randomUUID().replace(/-/g, "").slice(0, 16);
			try {
				const draft = await deps.write(material, chatId, run.controller.signal, (u, model) => {
					usage.push({ model, step: deps.toCallUsage(u) });
					run.model = model;
					run.steps += 1;
					deps.activityChanged();
				});
				if (run.controller.signal.aborted) throw new Error("aborted");
				const pack = packFromDraft(packId, chatId, new Date(now()).toISOString(), draft);
				const stored = deps.chatStore.updateOfflinePacks(chatId, (packs) => [...packs, pack]);
				if (stored === null) throw new Error("the session was deleted");
				runs.delete(run.id);
			} catch (err) {
				if (run.controller.signal.aborted) runs.delete(run.id);
				else {
					run.status = "failed";
					run.error = err instanceof Error ? err.message : String(err);
					schedule(() => { if (runs.get(run.id)?.status === "failed") { runs.delete(run.id); deps.activityChanged(); } }, FAILED_ROW_MS);
				}
			} finally {
				// Every call is billed to the session, failed runs included.
				usage.forEach((u, i) => deps.chatStore.appendTurnUsage(chatId, {
					id: `pack_${packId}_${i}`, messageId: `pack:${packId}`, at: new Date(now()).toISOString(), model: u.model, steps: [u.step],
				}));
				deps.notify(chatId);
				deps.activityChanged();
			}
		})();
		return run;
	}

	/** Ends a running pack (no pack is stored) or dismisses a failed row. */
	function abort(runId: string): boolean {
		const run = runs.get(runId);
		if (!run) return false;
		if (run.status === "running") run.controller.abort();
		runs.delete(runId);
		deps.activityChanged();
		return true;
	}

	function remove(chatId: string, packId: string): OfflinePack[] | null {
		const answered = deps.answeredKeys(chatId);
		const at = new Date(now()).toISOString();
		const result = deps.chatStore.updateOfflinePacks(chatId, (packs) => deletePack(packs, packId, answered, at));
		if (result !== null) deps.notify(chatId);
		return result;
	}

	function activity(): PackRun[] {
		return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	return { start, abort, remove, activity };
}

export type OfflinePacks = ReturnType<typeof createOfflinePacks>;
