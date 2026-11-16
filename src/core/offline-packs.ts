/**
 * OFFLINE PRACTICE PACKS (offline wave C, owner 2026-11-16) — the pure core.
 *
 * A pack is a batch of new quizzes and free-form problems the strong model
 * writes for one session while the computer is reachable, so the tablet has
 * fresh material offline. Packs live on the session record (offlinePacks),
 * not in the agent's history; an answered pack item reaches history only
 * through its offline-practice sitting. Pack items join the Leitner queue
 * like replayed questions (owner). Deleting a pack drops its unanswered
 * items; answered ones stay (owner).
 */
import { normalizeOptions, resolveCorrect, quizInputProblems } from "./question-core.ts";
import type { PracticeItem, ProblemPracticeItem, QuizPracticeItem } from "./offline-practice.ts";

export const PACK_MIN_ITEMS = 4;
export const PACK_MAX_ITEMS = 20;

/** One item as the generator submits it. */
export type PackDraftItem =
	| {
			kind: "quiz";
			question: string;
			options: { label: string; value?: string }[];
			multiSelect?: boolean;
			explanation: string;
			correctAnswer: string | string[];
			target?: string[];
	  }
	| {
			kind: "problem";
			statement: string;
			modelSolution: string;
			mode?: "recall" | "discrimination" | "composition";
			target?: string[];
	  };

export interface OfflinePack {
	id: string;
	createdAt: string;
	items: PracticeItem[];
	/** Set when the learner deleted the pack; the answered items it still
	 *  holds stay in the queue, the pack leaves the Packs list. */
	deletedAt?: string;
}

/** The Packs list row. */
export interface OfflinePackSummary {
	id: string;
	chatId: string;
	createdAt: string;
	quizzes: number;
	problems: number;
}

export function packItemKey(packId: string, index: number): string {
	return `pack:${packId}:${index}`;
}

/** Problems with one draft (empty = usable). Mirrors the live quiz
 *  authoring contract; targets must be ids the generator was given. */
export function packDraftProblems(items: readonly PackDraftItem[], knownTargets: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	if (items.length < PACK_MIN_ITEMS || items.length > PACK_MAX_ITEMS) {
		problems.push(`a pack has ${PACK_MIN_ITEMS}–${PACK_MAX_ITEMS} items; this one has ${items.length}`);
	}
	items.forEach((item, i) => {
		const at = `items[${i}]`;
		if (item.kind === "quiz") {
			if (!item.question.trim()) problems.push(`${at}.question is empty`);
			if (!item.explanation.trim()) problems.push(`${at}.explanation is empty`);
			for (const p of quizInputProblems(item)) problems.push(`${at}: ${p}`);
		} else {
			if (!item.statement.trim()) problems.push(`${at}.statement is empty`);
			if (!item.modelSolution.trim()) problems.push(`${at}.modelSolution is empty`);
		}
		const unknown = (item.target ?? []).filter((t) => !knownTargets.has(t));
		if (unknown.length > 0) problems.push(`${at}.target ${JSON.stringify(unknown)} are not listed proposition ids — use listed ids or omit target`);
	});
	return problems;
}

/** Builds the stored pack from a validated draft. New items carry no
 *  original result; they queue after originally-missed replays. */
export function packFromDraft(packId: string, chatId: string, createdAt: string, items: readonly PackDraftItem[]): OfflinePack {
	const posedAt = Date.parse(createdAt);
	return {
		id: packId,
		createdAt,
		items: items.map((item, i): PracticeItem => {
			const key = packItemKey(packId, i);
			const target = item.target?.length ? { target: [...item.target] } : {};
			if (item.kind === "problem") {
				const p: ProblemPracticeItem = {
					key, chatId, kind: "problem", statement: item.statement.trim(), modelSolution: item.modelSolution.trim(),
					...(item.mode ? { mode: item.mode } : {}), ...target, original: "right", posedAt,
				};
				return p;
			}
			const options = normalizeOptions(item.options);
			const { indices } = resolveCorrect(item.correctAnswer, options);
			const correctValues = indices.map((n) => options[n - 1]!.value);
			const q: QuizPracticeItem = {
				key, chatId, kind: "quiz", tool: "quiz", question: item.question.trim(),
				options: options.map((o) => ({ label: o.label, value: o.value })),
				multiSelect: item.multiSelect === true || correctValues.length > 1,
				correctValues, explanation: item.explanation.trim(), ...target, original: "right", posedAt,
			};
			return q;
		}),
	};
}

export function packItemsOf(packs: readonly OfflinePack[] | undefined): PracticeItem[] {
	return (packs ?? []).flatMap((p) => p.items);
}

export function packSummaries(chatId: string, packs: readonly OfflinePack[] | undefined): OfflinePackSummary[] {
	return (packs ?? []).filter((p) => !p.deletedAt).map((p) => ({
		id: p.id,
		chatId,
		createdAt: p.createdAt,
		quizzes: p.items.filter((i) => i.kind === "quiz").length,
		problems: p.items.filter((i) => i.kind === "problem").length,
	}));
}

/** A change stamp over a session's packs (folds into the offline rev). */
export function packsRev(packs: readonly OfflinePack[] | undefined): string {
	return (packs ?? []).map((p) => `${p.id}:${p.items.length}:${p.deletedAt ?? ""}`).join("|");
}

/** Delete: keep only answered items (marked deleted); drop the pack when
 *  none was answered. Returns the new list (input untouched). */
export function deletePack(packs: readonly OfflinePack[], packId: string, answeredKeys: ReadonlySet<string>, at: string): OfflinePack[] {
	return packs.flatMap((p) => {
		if (p.id !== packId) return [p];
		const kept = p.items.filter((i) => answeredKeys.has(i.key));
		return kept.length === 0 ? [] : [{ ...p, items: kept, deletedAt: at }];
	});
}
