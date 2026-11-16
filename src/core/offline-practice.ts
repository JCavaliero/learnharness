/**
 * OFFLINE PRACTICE (offline wave B, owner 2026-11-16) — the pure core.
 *
 * - Practice items: every answered built-in quiz/probe call (answer key +
 *   explanation from the call's own arguments) and every concluded native
 *   practice problem (statement + committed model solution) in a session.
 *   Plugin questions/problems are skipped (owner: native only).
 * - Attempts: what the learner did on the device. Quizzes grade locally
 *   (and again on the server); problems wait for the background grader.
 * - Leitner: 5 boxes, 1/2/4/8/16 days. Right → next box (max 5), wrong →
 *   box 1, an ungraded problem attempt moves nothing (owner: wait for the
 *   grader) but restarts its interval. Items never retried start in box 1,
 *   due now, originally-missed ones first.
 * - The "offline-practice" history message: one per graded sitting, its
 *   model-facing text in the owner-approved format (offlinePracticeContent).
 */
import { normalizeOptions, resolveCorrect } from "./question-core.ts";
import {
	newMessageId,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";
import { readPluginQuestionMessageAnnotation } from "./plugin-questions.ts";
import type { CallUsage } from "./contracts/chat.ts";

// ─── items ──────────────────────────────────────────────────────────────────

export type PracticeResult = "right" | "wrong";

export interface QuizPracticeItem {
	key: string;
	chatId: string;
	kind: "quiz";
	/** The posing tool: teach-phase "quiz" or probe-phase "probe". */
	tool: "quiz" | "probe";
	question: string;
	/** The quiz's optional extra context line. */
	details?: string;
	options: { label: string; value: string }[];
	multiSelect: boolean;
	correctValues: string[];
	explanation: string;
	/** The plan-tree node slug a teach quiz is tagged with. */
	nodeId?: string;
	/** The result when it was first answered in the session. */
	original: PracticeResult;
	posedAt: number;
}

export interface ProblemPracticeItem {
	key: string;
	chatId: string;
	kind: "problem";
	statement: string;
	modelSolution: string;
	mode?: string;
	/** Canonical proposition ids (the mastery-trace contract). */
	target?: string[];
	original: PracticeResult;
	posedAt: number;
}

export type PracticeItem = QuizPracticeItem | ProblemPracticeItem;

export function practiceItemKey(chatId: string, toolCallId: string): string {
	return `${chatId}:${toolCallId}`;
}

const QUIZ_TOOLS = new Set(["quiz", "probe"]);

/** The replayable items of one session, in transcript order. */
export function practiceItemsOf(chatId: string, messages: readonly LhMessage[]): PracticeItem[] {
	const results = new Map<string, LhMessage & { role: "toolResult" }>();
	for (const m of messages) if (m.role === "toolResult" && !m.isError) results.set(m.toolCallId, m as LhMessage & { role: "toolResult" });

	const outcomes = new Map<string, string>();
	const problems: { id: string; args: Record<string, unknown>; at: number }[] = [];
	const items: (PracticeItem | { pendingProblem: string })[] = [];
	let lastProblem: string | null = null;

	for (const m of messages) {
		if (m.role === "custom" && m.customType === "problem-dismissed") {
			const id = (m.details as { problemCallId?: unknown } | null)?.problemCallId;
			if (typeof id === "string" && !outcomes.has(id)) outcomes.set(id, "dismissed");
			continue;
		}
		if (m.role !== "assistant") continue;
		for (const [contentIndex, block] of m.content.entries()) {
			if (block.type !== "toolCall" || !results.has(block.id)) continue;
			const args = (block.arguments ?? {}) as Record<string, unknown>;
			if (QUIZ_TOOLS.has(block.name)) {
				if (readPluginQuestionMessageAnnotation(m, contentIndex).status !== "absent") continue;
				const item = quizItem(chatId, block.id, block.name as "quiz" | "probe", args, results.get(block.id)!.details, m.timestamp);
				if (item) items.push(item);
			} else if (block.name === PRACTICE_PROBLEM_TOOL) {
				lastProblem = block.id;
				problems.push({ id: block.id, args, at: m.timestamp });
				items.push({ pendingProblem: block.id });
			} else if (block.name === PRACTICE_CONCLUDE_TOOL && lastProblem && !outcomes.has(lastProblem)) {
				outcomes.set(lastProblem, typeof args.outcome === "string" ? args.outcome : "");
			}
		}
	}

	const byId = new Map(problems.map((p) => [p.id, p]));
	const out: PracticeItem[] = [];
	for (const entry of items) {
		if (!("pendingProblem" in entry)) { out.push(entry); continue; }
		const outcome = outcomes.get(entry.pendingProblem);
		if (outcome === undefined) continue; // still active (or never concluded)
		const p = byId.get(entry.pendingProblem)!;
		const statement = typeof p.args.statement === "string" ? p.args.statement.trim() : "";
		const modelSolution = typeof p.args.modelSolution === "string" ? p.args.modelSolution.trim() : "";
		if (!statement || !modelSolution) continue;
		const target = Array.isArray(p.args.target) ? (p.args.target as unknown[]).filter((t): t is string => typeof t === "string") : [];
		out.push({
			key: practiceItemKey(chatId, p.id),
			chatId,
			kind: "problem",
			statement,
			modelSolution,
			...(typeof p.args.mode === "string" ? { mode: p.args.mode } : {}),
			...(target.length > 0 ? { target } : {}),
			original: outcome === "solved" ? "right" : "wrong",
			posedAt: p.at,
		});
	}
	return out;
}

function quizItem(chatId: string, callId: string, tool: "quiz" | "probe", args: Record<string, unknown>, details: unknown, at: number): QuizPracticeItem | null {
	const question = typeof args.question === "string" ? args.question.trim() : "";
	if (!question) return null;
	let options;
	try { options = normalizeOptions(args.options as Parameters<typeof normalizeOptions>[0]); }
	catch { return null; }
	if (options.length < 2) return null;
	const { indices, error } = resolveCorrect(args.correctAnswer as string | string[] | undefined, options);
	if (error || indices.length === 0) return null;
	const correctValues = indices.map((i) => options[i - 1]!.value);
	const extra = typeof args.details === "string" && args.details.trim() ? args.details.trim() : undefined;
	return {
		key: practiceItemKey(chatId, callId),
		chatId,
		kind: "quiz",
		tool,
		question,
		...(extra ? { details: extra } : {}),
		options: options.map((o) => ({ label: o.label, value: o.value })),
		multiSelect: args.multiSelect === true || correctValues.length > 1,
		correctValues,
		explanation: typeof args.explanation === "string" ? args.explanation.trim() : "",
		...(typeof args.nodeId === "string" && args.nodeId ? { nodeId: args.nodeId } : {}),
		original: (details as { correct?: unknown } | null)?.correct === true ? "right" : "wrong",
		posedAt: at,
	};
}

// ─── attempts ───────────────────────────────────────────────────────────────

/** One answer given on the device. */
export interface DeviceAttempt {
	/** Device-minted uuid — the idempotency key end to end. */
	id: string;
	itemKey: string;
	chatId: string;
	kind: "quiz" | "problem";
	answeredAt: string;
	/** quiz: the chosen option values. */
	selected?: string[];
	/** quiz: graded on the device (the server re-grades from the record). */
	correct?: boolean;
	/** quiz: "I don't know" (counts as wrong; nothing selected). */
	dontKnow?: boolean;
	/** quiz: the confidence stop (0–100), absent with "I don't know". */
	confidence?: number;
	/** problem: the learner's written answer (text only, owner). */
	answer?: string;
}

export const MAX_ATTEMPTS_PER_UPLOAD = 500;
export const MAX_ANSWER_CHARS = 20_000;

export function gradeQuizSelection(item: Pick<QuizPracticeItem, "correctValues">, selected: readonly string[]): boolean {
	const want = new Set(item.correctValues);
	const got = new Set(selected);
	return want.size === got.size && [...want].every((v) => got.has(v));
}

/** Validates an attempts upload. Malformed input throws (route → 400). */
export function parseAttemptUpload(raw: unknown): DeviceAttempt[] {
	const list = (raw as { attempts?: unknown } | null)?.attempts;
	if (!Array.isArray(list)) throw new Error("attempts must be an array");
	if (list.length > MAX_ATTEMPTS_PER_UPLOAD) throw new Error("too many attempts in one upload");
	return list.map((a, i) => {
		const o = (a ?? {}) as Record<string, unknown>;
		const str = (k: string) => {
			if (typeof o[k] !== "string" || !(o[k] as string)) throw new Error(`attempts[${i}].${k} must be a non-empty string`);
			return o[k] as string;
		};
		const id = str("id"), itemKey = str("itemKey"), chatId = str("chatId"), answeredAt = str("answeredAt");
		if (Number.isNaN(Date.parse(answeredAt))) throw new Error(`attempts[${i}].answeredAt must be an ISO date`);
		if (!itemKey.startsWith(`${chatId}:`) && !itemKey.startsWith("pack:")) throw new Error(`attempts[${i}].itemKey does not belong to its chat`);
		if (o.kind === "quiz") {
			if (!Array.isArray(o.selected) || o.selected.some((v) => typeof v !== "string")) throw new Error(`attempts[${i}].selected must be strings`);
			const dontKnow = o.dontKnow === true;
			const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(100, Math.round(o.confidence))) : undefined;
			return {
				id, itemKey, chatId, kind: "quiz", answeredAt, selected: dontKnow ? [] : o.selected as string[],
				...(typeof o.correct === "boolean" ? { correct: o.correct } : {}),
				...(dontKnow ? { dontKnow: true } : confidence !== undefined ? { confidence } : {}),
			};
		}
		if (o.kind === "problem") {
			if (typeof o.answer !== "string") throw new Error(`attempts[${i}].answer must be a string`);
			if (o.answer.length > MAX_ANSWER_CHARS) throw new Error(`attempts[${i}].answer is too long`);
			return { id, itemKey, chatId, kind: "problem", answeredAt, answer: o.answer };
		}
		throw new Error(`attempts[${i}].kind must be quiz or problem`);
	});
}

// ─── the grader's verdict ───────────────────────────────────────────────────

export type GraderOutcome = "solved" | "movedOn" | "surrendered";
export type MissClass = "cue" | "discrimination" | "execution" | "careless" | "structural";

export interface GraderVerdict {
	outcome: GraderOutcome;
	verdict: string;
	missClass: MissClass | null;
	retest: boolean;
}

// ─── the history message ────────────────────────────────────────────────────

/** One answered item inside a sitting's message (UI payload + the source
 *  of the model-facing text). */
export type OfflinePracticeEntry =
	| {
			attemptId: string; itemKey: string; kind: "quiz"; answeredAt: string;
			question: string; nodeId?: string;
			chosen: string[]; correctLabels: string[]; correct: boolean; explanation: string;
			dontKnow?: boolean; confidence?: number;
	  }
	| {
			attemptId: string; itemKey: string; kind: "problem"; answeredAt: string;
			statement: string; target?: string[];
			answer: string; modelSolution: string; grade: GraderVerdict;
	  };

export interface OfflinePracticeDetails {
	sittingId: string;
	entries: OfflinePracticeEntry[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Nov 2026", "14–15 Nov 2026", "30 Oct – 2 Nov 2026", "30 Dec 2026 – 2 Jan 2027" (UTC). */
export function formatDateRange(fromIso: string, toIso: string): string {
	const a = new Date(fromIso), b = new Date(toIso);
	const [d1, m1, y1] = [a.getUTCDate(), a.getUTCMonth(), a.getUTCFullYear()];
	const [d2, m2, y2] = [b.getUTCDate(), b.getUTCMonth(), b.getUTCFullYear()];
	if (y1 === y2 && m1 === m2) return d1 === d2 ? `${d1} ${MONTHS[m1]} ${y1}` : `${d1}–${d2} ${MONTHS[m1]} ${y1}`;
	if (y1 === y2) return `${d1} ${MONTHS[m1]} – ${d2} ${MONTHS[m2]} ${y1}`;
	return `${d1} ${MONTHS[m1]} ${y1} – ${d2} ${MONTHS[m2]} ${y2}`;
}

const OUTCOME_TEXT: Record<GraderOutcome, string> = { solved: "solved", movedOn: "moved on", surrendered: "surrendered" };

function indentRest(text: string): string {
	return text.trim().replace(/\n/g, "\n   ");
}

/** The model-facing text (owner-approved format, 2026-11-16). */
export function offlinePracticeContent(details: OfflinePracticeDetails): string {
	const times = details.entries.map((e) => e.answeredAt).sort();
	const range = times.length > 0 ? formatDateRange(times[0]!, times[times.length - 1]!) : "";
	const lines = [
		`[Offline practice — answered on the learner's device while disconnected, ${range}. Recorded for context; not a request for a reply.]`,
		"",
	];
	details.entries.forEach((e, i) => {
		const n = `${i + 1}.`;
		if (e.kind === "quiz") {
			const tag = e.nodeId ? ` [node: ${e.nodeId}]` : "";
			lines.push(`${n} Quiz${tag}: "${indentRest(e.question)}"`);
			const chosen = e.dontKnow ? "I don't know" : e.chosen.length > 0 ? e.chosen.map((c) => `"${c}"`).join(", ") : "nothing";
			const confidence = e.confidence !== undefined ? ` (confidence ${e.confidence}%)` : "";
			const verdict = e.correct ? "correct" : `incorrect (correct: ${e.correctLabels.map((c) => `"${c}"`).join(", ")})`;
			lines.push(`   Learner chose: ${chosen}${confidence} — ${verdict}`);
		} else {
			const tag = e.target?.length ? ` [targets: ${e.target.join(", ")}]` : "";
			lines.push(`${n} Problem${tag}: "${indentRest(e.statement)}"`);
			lines.push(`   Learner's answer: ${e.answer.trim() ? indentRest(e.answer) : "(blank)"}`);
			const extras = [
				...(e.grade.missClass ? [`miss: ${e.grade.missClass}`] : []),
				...(e.grade.retest ? ["retest: yes"] : []),
			];
			lines.push(`   Graded: ${OUTCOME_TEXT[e.grade.outcome]} — "${indentRest(e.grade.verdict)}"${extras.length ? ` (${extras.join("; ")})` : ""}`);
		}
	});
	return lines.join("\n");
}

export function newOfflinePracticeMessage(details: OfflinePracticeDetails, now = Date.now()): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "offline-practice",
		content: offlinePracticeContent(details),
		display: true,
		details,
		timestamp: now,
	};
}

/** Defensive read of a marker's details (records are disk data). */
export function readOfflinePracticeDetails(details: unknown): OfflinePracticeDetails | null {
	const d = details as Partial<OfflinePracticeDetails> | null;
	if (!d || typeof d.sittingId !== "string" || !Array.isArray(d.entries)) return null;
	return d as OfflinePracticeDetails;
}

// ─── server-side sittings ───────────────────────────────────────────────────

/** One uploaded attempt inside a sitting, with the item snapshot it was
 *  checked against and (problems) the grader's verdict once graded. */
export interface SittingAttempt {
	attempt: DeviceAttempt;
	item: PracticeItem;
	/** quiz: the server's own grade. */
	correct?: boolean;
	grade?: GraderVerdict;
}

/** All attempts for one session from one upload (owner: one sitting =
 *  one sync per session). Graded first, then appended once the session is
 *  idle (no turn, no pending question, no active problem, no compaction). */
export interface PendingSitting {
	id: string;
	chatId: string;
	createdAt: string;
	attempts: SittingAttempt[];
	/** grading: problems still ungraded · waiting: graded, session busy ·
	 *  failed: grading gave up after the retries (Retry resets). */
	status: "grading" | "waiting" | "failed";
	/** Failed grading rounds so far (0..3 retries after the first). */
	tries: number;
	/** ISO — the next grading round; absent = now. */
	nextTryAt?: string;
	lastError?: string;
	/** Grader usage, every call (failed rounds too) — logged on the
	 *  session's cost when the sitting is appended (owner). */
	usage?: { model: string; steps: CallUsage[] }[];
}

/** The sitting's history-message details: entries in answer order. */
export function sittingDetails(s: PendingSitting): OfflinePracticeDetails {
	const entries: OfflinePracticeEntry[] = [...s.attempts]
		.sort((a, b) => a.attempt.answeredAt.localeCompare(b.attempt.answeredAt))
		.map(({ attempt, item, correct, grade }) => {
			if (item.kind === "quiz") {
				const label = (v: string) => item.options.find((o) => o.value === v)?.label ?? v;
				return {
					attemptId: attempt.id, itemKey: item.key, kind: "quiz" as const, answeredAt: attempt.answeredAt,
					question: item.question, ...(item.nodeId ? { nodeId: item.nodeId } : {}),
					chosen: (attempt.selected ?? []).map(label), correctLabels: item.correctValues.map(label),
					correct: correct === true, explanation: item.explanation,
					...(attempt.dontKnow ? { dontKnow: true } : attempt.confidence !== undefined ? { confidence: attempt.confidence } : {}),
				};
			}
			return {
				attemptId: attempt.id, itemKey: item.key, kind: "problem" as const, answeredAt: attempt.answeredAt,
				statement: item.statement, ...(item.target?.length ? { target: item.target } : {}),
				answer: attempt.answer ?? "", modelSolution: item.modelSolution, grade: grade!,
			};
		});
	return { sittingId: s.id, entries };
}

/** A sitting's attempts as the queue reads them (status from the sitting). */
export function sittingAttemptRecords(s: PendingSitting): AttemptRecord[] {
	const status: AttemptRecord["status"] = s.status;
	return s.attempts.map(({ attempt, correct, grade }) => ({
		id: attempt.id, itemKey: attempt.itemKey, chatId: s.chatId, kind: attempt.kind, answeredAt: attempt.answeredAt,
		result: attempt.kind === "quiz" ? (correct ? "right" : "wrong") : grade ? resultOfVerdict(grade) : "pending",
		status,
		...(attempt.selected ? { selected: attempt.selected } : {}),
		...(attempt.answer !== undefined ? { answer: attempt.answer } : {}),
		...(grade ? { grade } : {}),
	}));
}

// ─── attempt history (Leitner input) ────────────────────────────────────────

/** One attempt as the queue and the device's results list read it. */
export interface AttemptRecord {
	id: string;
	itemKey: string;
	chatId: string;
	kind: "quiz" | "problem";
	answeredAt: string;
	/** pending = a problem attempt not graded yet (moves no box). */
	result: PracticeResult | "pending";
	/** Where the attempt stands: in the session's history, waiting on the
	 *  server (grading / waiting for the session / grading failed), or
	 *  still only on this device. */
	status: "recorded" | "grading" | "waiting" | "failed" | "local";
	answer?: string;
	selected?: string[];
	grade?: GraderVerdict;
}

export function resultOfVerdict(v: GraderVerdict): PracticeResult {
	return v.outcome === "solved" ? "right" : "wrong";
}

/** Attempts already recorded in a session's history (its sitting messages). */
export function recordedAttemptsOf(chatId: string, messages: readonly LhMessage[]): AttemptRecord[] {
	const out: AttemptRecord[] = [];
	for (const m of messages) {
		if (m.role !== "custom" || m.customType !== "offline-practice") continue;
		const details = readOfflinePracticeDetails(m.details);
		if (!details) continue;
		for (const e of details.entries) {
			out.push(e.kind === "quiz"
				? { id: e.attemptId, itemKey: e.itemKey, chatId, kind: "quiz", answeredAt: e.answeredAt, result: e.correct ? "right" : "wrong", status: "recorded", selected: e.chosen }
				: { id: e.attemptId, itemKey: e.itemKey, chatId, kind: "problem", answeredAt: e.answeredAt, result: resultOfVerdict(e.grade), status: "recorded", answer: e.answer, grade: e.grade });
		}
	}
	return out;
}

// ─── Leitner ────────────────────────────────────────────────────────────────

export const LEITNER_INTERVAL_DAYS = [1, 2, 4, 8, 16] as const;
const DAY_MS = 86_400_000;

export interface LeitnerState {
	/** 1..5 */
	box: number;
	/** ms of the newest attempt; null = never retried. */
	lastAt: number | null;
	/** ms when it is due; -Infinity = due now (never retried). */
	dueAt: number;
}

export function leitnerStates(items: readonly PracticeItem[], attempts: readonly AttemptRecord[]): Map<string, LeitnerState> {
	const states = new Map<string, LeitnerState>(items.map((i) => [i.key, { box: 1, lastAt: null, dueAt: -Infinity }]));
	const ordered = [...attempts].sort((a, b) => a.answeredAt.localeCompare(b.answeredAt) || a.id.localeCompare(b.id));
	const seen = new Set<string>();
	for (const a of ordered) {
		if (seen.has(a.id)) continue;
		seen.add(a.id);
		const s = states.get(a.itemKey);
		if (!s) continue;
		const t = Date.parse(a.answeredAt);
		if (a.result === "right") s.box = Math.min(LEITNER_INTERVAL_DAYS.length, s.box + 1);
		else if (a.result === "wrong") s.box = 1;
		s.lastAt = t;
		s.dueAt = t + LEITNER_INTERVAL_DAYS[s.box - 1]! * DAY_MS;
	}
	return states;
}

function shuffled<T>(list: T[], rand: () => number): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/**
 * The mixed queue: due reviews first (earliest due first), then items
 * never retried — originally missed before originally right, shuffled
 * within each group. `ahead` (owner: "Practice ahead") serves the
 * soonest-due items when nothing is due.
 */
export function practiceQueue(
	items: readonly PracticeItem[],
	states: ReadonlyMap<string, LeitnerState>,
	now: number,
	opts: { ahead?: boolean; rand?: () => number } = {},
): PracticeItem[] {
	const rand = opts.rand ?? Math.random;
	const stateOf = (i: PracticeItem) => states.get(i.key) ?? { box: 1, lastAt: null, dueAt: -Infinity };
	const due = items.filter((i) => stateOf(i).dueAt <= now);
	if (due.length === 0) {
		if (!opts.ahead) return [];
		return [...items].sort((a, b) => stateOf(a).dueAt - stateOf(b).dueAt);
	}
	const reviews = due.filter((i) => stateOf(i).lastAt !== null).sort((a, b) => stateOf(a).dueAt - stateOf(b).dueAt);
	const fresh = due.filter((i) => stateOf(i).lastAt === null);
	return [
		...reviews,
		...shuffled(fresh.filter((i) => i.original === "wrong"), rand),
		...shuffled(fresh.filter((i) => i.original === "right"), rand),
	];
}

/** The soonest future due time (for "All caught up — next due …"). */
export function nextDueAt(states: ReadonlyMap<string, LeitnerState>, now: number): number | null {
	let best: number | null = null;
	for (const s of states.values()) if (s.dueAt > now && (best === null || s.dueAt < best)) best = s.dueAt;
	return best;
}

// ─── the device's merged view ───────────────────────────────────────────────

/** A device attempt the server does not list yet. */
export function localAttemptRecord(a: DeviceAttempt): AttemptRecord {
	return {
		id: a.id, itemKey: a.itemKey, chatId: a.chatId, kind: a.kind, answeredAt: a.answeredAt,
		result: a.kind === "quiz" ? (a.correct && !a.dontKnow ? "right" : "wrong") : "pending",
		status: "local",
		...(a.selected ? { selected: a.selected } : {}),
		...(a.answer !== undefined ? { answer: a.answer } : {}),
	};
}

/** One list per id, the most settled copy winning: recorded (in a
 *  history) > on the server > only on this device. */
export function mergeAttemptRecords(recorded: readonly AttemptRecord[], server: readonly AttemptRecord[], local: readonly DeviceAttempt[]): AttemptRecord[] {
	const out = new Map<string, AttemptRecord>();
	for (const a of local) out.set(a.id, localAttemptRecord(a));
	for (const a of server) out.set(a.id, a);
	for (const a of recorded) out.set(a.id, a);
	return [...out.values()];
}
