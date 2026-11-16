/**
 * Offline practice on the server (offline wave B, owner 2026-11-16).
 *
 * accept(): an upload of device attempts. Each attempt is checked against
 * the item rebuilt from its session record (quizzes re-graded here), and
 * one sitting per session is stored (data/offline/pending). Re-uploads of
 * an attempt already pending or recorded are accepted again (idempotent).
 *
 * process(): grades ungraded free-form answers with the cheap-tier grader
 * (first round immediately, then 3 retries at 1 / 5 / 15 minutes, then
 * "failed" until Retry). A fully graded sitting is appended to its
 * session's history as ONE offline-practice message — only while the
 * session is idle (no turn, no compaction, no pending question, no active
 * problem). The check and the save are one synchronous stretch, so no turn
 * can start in between. Grader usage lands in the session's cost log.
 */
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import {
	gradeQuizSelection,
	newOfflinePracticeMessage,
	practiceItemsOf,
	recordedAttemptsOf,
	sittingAttemptRecords,
	sittingDetails,
	type AttemptRecord,
	type DeviceAttempt,
	type GraderVerdict,
	type PendingSitting,
	type PracticeItem,
	type SittingAttempt,
} from "../core/offline-practice.ts";
import { activeProblemOf, hasUnresolvedQuestion, pendingPluginQuestionOf } from "../core/native-messages.ts";
import type { ChatStore, OfflineSittingStore } from "../core/ports.ts";
import type { CallUsage } from "../core/contracts/chat.ts";

export const GRADE_RETRY_MINUTES = [1, 5, 15] as const;

export interface OfflinePracticeDeps {
	chatStore: Pick<ChatStore, "getChat" | "saveMessages" | "appendTurnUsage">;
	sittings: OfflineSittingStore;
	/** A turn or compaction is running for the session. */
	isSessionBusy: (chatId: string) => boolean;
	grade: (input: { statement: string; modelSolution: string; answer: string }, chatId: string, onStep: (usage: Usage, model: string) => void) => Promise<GraderVerdict>;
	toCallUsage: (usage: Usage) => CallUsage;
	/** Extra items beyond the session's own (wave C packs). */
	extraItemsOf?: (chatId: string) => PracticeItem[];
	notify?: (chatId: string) => void;
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => { unref?: () => void } | number;
	cancel?: (handle: unknown) => void;
}

export interface AcceptResult {
	accepted: string[];
	rejected: { id: string; reason: string }[];
}

export function createOfflinePractice(deps: OfflinePracticeDeps) {
	const now = deps.now ?? Date.now;
	const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	let running: Promise<void> | null = null;
	let again = false;
	let timer: unknown = null;

	function itemsFor(chatId: string, messages: Parameters<typeof practiceItemsOf>[1]): Map<string, PracticeItem> {
		return new Map([...practiceItemsOf(chatId, messages), ...(deps.extraItemsOf?.(chatId) ?? [])].map((i) => [i.key, i]));
	}

	function accept(attempts: readonly DeviceAttempt[]): AcceptResult {
		const result: AcceptResult = { accepted: [], rejected: [] };
		const pending = new Set(deps.sittings.list().flatMap((s) => s.attempts.map((a) => a.attempt.id)));
		const byChat = new Map<string, DeviceAttempt[]>();
		for (const a of attempts) byChat.set(a.chatId, [...(byChat.get(a.chatId) ?? []), a]);
		for (const [chatId, list] of byChat) {
			const record = deps.chatStore.getChat(chatId);
			if (!record) { for (const a of list) result.rejected.push({ id: a.id, reason: "session not found" }); continue; }
			const items = itemsFor(chatId, record.messages);
			const recorded = new Set(recordedAttemptsOf(chatId, record.messages).map((r) => r.id));
			const fresh: SittingAttempt[] = [];
			const seen = new Set<string>();
			for (const attempt of list) {
				if (pending.has(attempt.id) || recorded.has(attempt.id)) { result.accepted.push(attempt.id); continue; }
				if (seen.has(attempt.id)) continue;
				const item = items.get(attempt.itemKey);
				if (!item) { result.rejected.push({ id: attempt.id, reason: "item not found" }); continue; }
				if (item.kind !== attempt.kind) { result.rejected.push({ id: attempt.id, reason: "kind mismatch" }); continue; }
				if (item.kind === "quiz") {
					const values = new Set(item.options.map((o) => o.value));
					if ((attempt.selected ?? []).some((v) => !values.has(v))) { result.rejected.push({ id: attempt.id, reason: "unknown option" }); continue; }
					fresh.push({ attempt, item, correct: !attempt.dontKnow && gradeQuizSelection(item, attempt.selected ?? []) });
				} else {
					fresh.push({ attempt, item });
				}
				seen.add(attempt.id);
				result.accepted.push(attempt.id);
			}
			if (fresh.length === 0) continue;
			const sitting: PendingSitting = {
				id: `sit_${randomUUID().replace(/-/g, "")}`,
				chatId,
				createdAt: new Date(now()).toISOString(),
				attempts: fresh,
				status: fresh.some((a) => a.item.kind === "problem") ? "grading" : "waiting",
				tries: 0,
			};
			deps.sittings.put(sitting);
			deps.notify?.(chatId);
		}
		kick();
		return result;
	}

	async function gradeSitting(s: PendingSitting): Promise<void> {
		const usage = s.usage ?? [];
		try {
			for (const a of s.attempts) {
				if (a.item.kind !== "problem" || a.grade) continue;
				const steps: { model: string; step: CallUsage }[] = [];
				try {
					a.grade = await deps.grade(
						{ statement: a.item.statement, modelSolution: a.item.modelSolution, answer: a.attempt.answer ?? "" },
						s.chatId,
						(u, model) => steps.push({ model, step: deps.toCallUsage(u) }),
					);
				} finally {
					if (steps.length > 0) usage.push({ model: steps[0]!.model, steps: steps.map((x) => x.step) });
				}
			}
			s.status = "waiting";
			delete s.nextTryAt;
			delete s.lastError;
		} catch (err) {
			s.tries += 1;
			s.lastError = err instanceof Error ? err.message : String(err);
			if (s.tries > GRADE_RETRY_MINUTES.length) {
				s.status = "failed";
				delete s.nextTryAt;
			} else {
				s.nextTryAt = new Date(now() + GRADE_RETRY_MINUTES[s.tries - 1]! * 60_000).toISOString();
			}
		}
		s.usage = usage;
		deps.sittings.put(s);
		deps.notify?.(s.chatId);
	}

	/** Synchronous: idle check and save with no await in between. */
	function tryAppend(s: PendingSitting): boolean {
		const record = deps.chatStore.getChat(s.chatId);
		if (!record) { deps.sittings.remove(s.id); return true; } // session deleted
		if (deps.isSessionBusy(s.chatId)) return false;
		if (hasUnresolvedQuestion(record.messages) || pendingPluginQuestionOf(record.messages) || activeProblemOf(record.messages)) return false;
		const message = newOfflinePracticeMessage(sittingDetails(s), now());
		deps.chatStore.saveMessages(s.chatId, [...record.messages, message]);
		(s.usage ?? []).forEach((u, i) => deps.chatStore.appendTurnUsage(s.chatId, {
			id: `offline_${s.id}_${i}`, messageId: message.id, at: new Date(now()).toISOString(), model: u.model, steps: u.steps,
		}));
		deps.sittings.remove(s.id);
		deps.notify?.(s.chatId);
		return true;
	}

	async function runOnce(): Promise<void> {
		for (const s of deps.sittings.list()) {
			if (s.status === "grading" && (!s.nextTryAt || Date.parse(s.nextTryAt) <= now())) await gradeSitting(s);
			if (s.status === "waiting") tryAppend(s);
		}
		const next = deps.sittings.list()
			.filter((s) => s.status === "grading" && s.nextTryAt)
			.map((s) => Date.parse(s.nextTryAt!))
			.sort((a, b) => a - b)[0];
		const waiting = deps.sittings.list().some((s) => s.status === "waiting");
		if (timer !== null) { cancel(timer); timer = null; }
		// A waiting sitting re-checks every minute as a fallback to the
		// session events (a question answered with no turn, a deleted chat).
		const delay = next !== undefined ? Math.max(0, next - now()) : waiting ? 60_000 : null;
		if (delay !== null) {
			const handle = schedule(() => { timer = null; kick(); }, Math.min(delay, 60_000));
			if (typeof handle === "object" && handle?.unref) handle.unref();
			timer = handle;
		}
	}

	/** Single-flight: a kick during a run schedules one more run. */
	function kick(): Promise<void> {
		if (running) { again = true; return running; }
		running = (async () => {
			try {
				do { again = false; await runOnce(); } while (again);
			} catch (err) {
				console.error("[offline] sitting processing failed:", err);
			} finally {
				running = null;
			}
		})();
		return running;
	}

	function retry(id: string): boolean {
		const s = deps.sittings.list().find((x) => x.id === id);
		if (!s || s.status !== "failed") return false;
		s.status = "grading";
		s.tries = 0;
		delete s.nextTryAt;
		deps.sittings.put(s);
		deps.notify?.(s.chatId);
		void kick();
		return true;
	}

	/** Every attempt the server holds that is not in a history yet. */
	function pendingAttemptRecords(): AttemptRecord[] {
		return deps.sittings.list().flatMap(sittingAttemptRecords);
	}

	function sittingsOf(chatId: string) {
		return deps.sittings.list().filter((s) => s.chatId === chatId).map((s) => ({
			id: s.id, status: s.status, attempts: s.attempts.length, ...(s.lastError ? { lastError: s.lastError } : {}),
		}));
	}

	function chatsWithPending(): Set<string> {
		return new Set(deps.sittings.list().map((s) => s.chatId));
	}

	return { accept, kick, retry, pendingAttemptRecords, sittingsOf, chatsWithPending, tryAppend };
}

export type OfflinePractice = ReturnType<typeof createOfflinePractice>;
