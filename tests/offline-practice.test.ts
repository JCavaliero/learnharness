/**
 * OFFLINE PRACTICE CORE PINS (offline wave B, 2026-11-16): the item
 * extraction, attempt parsing, Leitner + queue, the owner-approved
 * model-facing text, and the new marker's projections.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatDateRange,
	gradeQuizSelection,
	leitnerStates,
	mergeAttemptRecords,
	newOfflinePracticeMessage,
	offlinePracticeContent,
	parseAttemptUpload,
	practiceItemsOf,
	practiceQueue,
	type AttemptRecord,
	type OfflinePracticeDetails,
	type PracticeItem,
} from "../src/core/offline-practice.ts";
import { nativeInputCause, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

let n = 0;
const id = () => `m${++n}`;
function call(name: string, callId: string, args: Record<string, unknown>, at = 1000): LhMessage {
	return { id: id(), role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: at, stopReason: "toolUse" } as unknown as LhMessage;
}
function result(name: string, callId: string, details: unknown = null): LhMessage {
	return { id: id(), role: "toolResult", toolCallId: callId, toolName: name, isError: false, content: [{ type: "text", text: "{}" }], details, timestamp: 2000 } as unknown as LhMessage;
}
const quizArgs = (extra: Record<string, unknown> = {}) => ({
	question: "2+2?", options: [{ label: "4", value: "four" }, { label: "5", value: "five" }], explanation: "Counting.", correctAnswer: "four", ...extra,
});

describe("practice items", () => {
	it("collects answered quizzes (teach + probe), concluded problems, and skips the rest", () => {
		const messages = [
			call("quiz", "q1", quizArgs({ nodeId: "addition" })), result("quiz", "q1", { kind: "quiz", correct: true }),
			call("probe", "q2", quizArgs()), result("probe", "q2", { kind: "quiz", correct: false }),
			call("quiz", "q3", quizArgs({ correctAnswer: "six" })), result("quiz", "q3", { kind: "quiz", correct: false }), // ungradeable
			call("quiz", "q4", quizArgs()), // never answered
			call("quiz", "q5", quizArgs()), result("quiz", "q5", { kind: "quiz", dismissed: true }),
			call("problem", "p1", { statement: "Prove it.", modelSolution: "Because.", mode: "recall", target: ["n_a"] }), result("problem", "p1"),
			call("conclude", "c1", { outcome: "solved", verdict: "ok" }), result("conclude", "c1"),
			call("problem", "p2", { statement: "Again.", modelSolution: "Sol." }), result("problem", "p2"),
			{ id: id(), role: "custom", customType: "problem-dismissed", content: "", display: false, details: { problemCallId: "p2" }, timestamp: 3000 } as unknown as LhMessage,
			call("problem", "p3", { statement: "Active.", modelSolution: "Hidden." }), result("problem", "p3"),
		];
		const items = practiceItemsOf("chat1", messages);
		assert.deepEqual(items.map((i) => [i.key, i.kind, i.original]), [
			["chat1:q1", "quiz", "right"],
			["chat1:q2", "quiz", "wrong"],
			["chat1:q5", "quiz", "wrong"],
			["chat1:p1", "problem", "right"],
			["chat1:p2", "problem", "wrong"],
		]);
		const q1 = items[0]!;
		assert.ok(q1.kind === "quiz" && q1.nodeId === "addition" && q1.tool === "quiz" && q1.correctValues[0] === "four" && !q1.multiSelect);
		const p1 = items[3]!;
		assert.ok(p1.kind === "problem" && p1.modelSolution === "Because." && p1.target?.[0] === "n_a");
	});

	it("grades quiz selections as exact sets", () => {
		const item = { correctValues: ["a", "b"] };
		assert.equal(gradeQuizSelection(item, ["b", "a"]), true);
		assert.equal(gradeQuizSelection(item, ["a"]), false);
		assert.equal(gradeQuizSelection(item, ["a", "b", "c"]), false);
	});
});

describe("attempt uploads", () => {
	it("parses quiz/problem attempts; I don't know clears the selection and drops confidence", () => {
		const parsed = parseAttemptUpload({ attempts: [
			{ id: "a1", itemKey: "c:q1", chatId: "c", kind: "quiz", answeredAt: "2026-11-16T10:00:00Z", selected: ["x"], correct: true, confidence: 70.4 },
			{ id: "a2", itemKey: "c:q1", chatId: "c", kind: "quiz", answeredAt: "2026-11-16T10:00:00Z", selected: ["x"], dontKnow: true, confidence: 90 },
			{ id: "a3", itemKey: "c:p1", chatId: "c", kind: "problem", answeredAt: "2026-11-16T10:00:00Z", answer: "my work" },
		] });
		assert.equal(parsed[0]!.confidence, 70);
		assert.deepEqual([parsed[1]!.selected, parsed[1]!.dontKnow, parsed[1]!.confidence], [[], true, undefined]);
		assert.equal(parsed[2]!.answer, "my work");
	});
	it("refuses malformed uploads", () => {
		assert.throws(() => parseAttemptUpload({}));
		assert.throws(() => parseAttemptUpload({ attempts: [{ id: "a", itemKey: "other:q", chatId: "c", kind: "quiz", answeredAt: "2026-11-16", selected: [] }] }), /belong/);
		assert.throws(() => parseAttemptUpload({ attempts: [{ id: "a", itemKey: "c:q", chatId: "c", kind: "essay", answeredAt: "2026-11-16" }] }));
		assert.throws(() => parseAttemptUpload({ attempts: [{ id: "a", itemKey: "c:q", chatId: "c", kind: "problem", answeredAt: "not a date", answer: "" }] }));
	});
});

describe("Leitner + queue", () => {
	const item = (key: string, original: "right" | "wrong"): PracticeItem => ({ key, chatId: "c", kind: "problem", statement: key, modelSolution: "s", original, posedAt: 0 });
	const attempt = (itemKey: string, at: string, result: AttemptRecord["result"], aid = `${itemKey}@${at}`): AttemptRecord =>
		({ id: aid, itemKey, chatId: "c", kind: "problem", answeredAt: at, result, status: "recorded" });
	const DAY = 86_400_000;

	it("right climbs a box (1/2/4/8/16 days), wrong resets, pending keeps the box but restarts the interval", () => {
		const items = [item("a", "right")];
		const t0 = Date.parse("2026-11-01T00:00:00Z");
		const states = leitnerStates(items, [
			attempt("a", "2026-11-01T00:00:00Z", "right"),
			attempt("a", "2026-11-03T00:00:00Z", "right"),
		]);
		assert.deepEqual(states.get("a"), { box: 3, lastAt: t0 + 2 * DAY, dueAt: t0 + 2 * DAY + 4 * DAY });
		const reset = leitnerStates(items, [attempt("a", "2026-11-01T00:00:00Z", "right"), attempt("a", "2026-11-02T00:00:00Z", "wrong")]);
		assert.equal(reset.get("a")!.box, 1);
		const pending = leitnerStates(items, [attempt("a", "2026-11-01T00:00:00Z", "right"), attempt("a", "2026-11-05T00:00:00Z", "pending")]);
		assert.deepEqual([pending.get("a")!.box, pending.get("a")!.dueAt], [2, t0 + 4 * DAY + 2 * DAY]);
		const capped = leitnerStates(items, Array.from({ length: 8 }, (_, i) => attempt("a", `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`, "right")));
		assert.equal(capped.get("a")!.box, 5);
	});

	it("serves due reviews first, then never-retried items (missed before right); ahead only when nothing is due", () => {
		const items = [item("fresh-right", "right"), item("fresh-wrong", "wrong"), item("review-late", "right"), item("review-early", "right"), item("not-due", "right")];
		const now = Date.parse("2026-11-20T00:00:00Z");
		const states = leitnerStates(items, [
			attempt("review-late", "2026-11-18T00:00:00Z", "wrong"), // due 11-19
			attempt("review-early", "2026-11-10T00:00:00Z", "wrong"), // due 11-11
			attempt("not-due", "2026-11-19T00:00:00Z", "right"), // box 2 → due 11-21
		]);
		assert.deepEqual(practiceQueue(items, states, now, { rand: () => 0 }).map((i) => i.key), ["review-early", "review-late", "fresh-wrong", "fresh-right"]);
		const allLater = leitnerStates([items[4]!], [attempt("not-due", "2026-11-19T00:00:00Z", "right")]);
		assert.deepEqual(practiceQueue([items[4]!], allLater, now), []);
		assert.deepEqual(practiceQueue([items[4]!], allLater, now, { ahead: true }).map((i) => i.key), ["not-due"]);
	});

	it("merges attempt lists, the most settled copy winning", () => {
		const recorded = [attempt("a", "2026-11-01T00:00:00Z", "right", "x")];
		const server = [{ ...attempt("a", "2026-11-01T00:00:00Z", "pending", "x"), status: "grading" as const }, { ...attempt("a", "2026-11-02T00:00:00Z", "pending", "y"), status: "grading" as const }];
		const local = [{ id: "y", itemKey: "a", chatId: "c", kind: "problem" as const, answeredAt: "2026-11-02T00:00:00Z", answer: "" }, { id: "z", itemKey: "a", chatId: "c", kind: "quiz" as const, answeredAt: "2026-11-03T00:00:00Z", selected: [], correct: true }];
		const merged = new Map(mergeAttemptRecords(recorded, server, local).map((a) => [a.id, a]));
		assert.deepEqual([merged.get("x")!.status, merged.get("y")!.status, merged.get("z")!.status, merged.get("z")!.result], ["recorded", "grading", "local", "right"]);
	});
});

describe("the offline-practice history message", () => {
	const details: OfflinePracticeDetails = {
		sittingId: "sit_abcdef",
		entries: [
			{ attemptId: "1", itemKey: "c:q1", kind: "quiz", answeredAt: "2026-11-14T09:00:00Z", question: "What is d/dx x²?", nodeId: "n_ab12", chosen: ["x"], correctLabels: ["2x"], correct: false, explanation: "Power rule.", confidence: 70 },
			{ attemptId: "2", itemKey: "c:p1", kind: "problem", answeredAt: "2026-11-15T09:00:00Z", statement: "Show that …", target: ["n_cd34"], answer: "first line\nsecond line", modelSolution: "…",
				grade: { outcome: "movedOn", verdict: "Set-up right; the chain rule step drops the inner derivative.", missClass: "execution", retest: true } },
			{ attemptId: "3", itemKey: "c:q2", kind: "quiz", answeredAt: "2026-11-15T10:00:00Z", question: "Pick one", chosen: [], correctLabels: ["a"], correct: false, explanation: "", dontKnow: true },
			{ attemptId: "4", itemKey: "c:p2", kind: "problem", answeredAt: "2026-11-15T11:00:00Z", statement: "Easy", answer: "done", modelSolution: "done",
				grade: { outcome: "solved", verdict: "Right.", missClass: null, retest: false } },
		],
	};

	it("renders the owner-approved format", () => {
		assert.equal(offlinePracticeContent(details), [
			"[Offline practice — answered on the learner's device while disconnected, 14–15 Nov 2026. Recorded for context; not a request for a reply.]",
			"",
			'1. Quiz [node: n_ab12]: "What is d/dx x²?"',
			'   Learner chose: "x" (confidence 70%) — incorrect (correct: "2x")',
			'2. Problem [targets: n_cd34]: "Show that …"',
			"   Learner's answer: first line",
			"   second line",
			'   Graded: moved on — "Set-up right; the chain rule step drops the inner derivative." (miss: execution; retest: yes)',
			'3. Quiz: "Pick one"',
			'   Learner chose: I don\'t know — incorrect (correct: "a")',
			'4. Problem: "Easy"',
			"   Learner's answer: done",
			'   Graded: solved — "Right."',
		].join("\n"));
	});

	it("formats date ranges", () => {
		assert.equal(formatDateRange("2026-11-14T01:00:00Z", "2026-11-14T23:00:00Z"), "14 Nov 2026");
		assert.equal(formatDateRange("2026-10-30T00:00:00Z", "2026-11-02T00:00:00Z"), "30 Oct – 2 Nov 2026");
		assert.equal(formatDateRange("2026-12-30T00:00:00Z", "2027-01-02T00:00:00Z"), "30 Dec 2026 – 2 Jan 2027");
	});

	it("is neutral input, reaches the model as its text, renders a card and a markdown block", () => {
		const message = newOfflinePracticeMessage(details, 5000);
		assert.equal(nativeInputCause(message as never, []), "neutral");
		const llm = toLlmMessages([message as never]);
		assert.equal(llm.length, 1);
		assert.equal(llm[0]!.role, "user");
		assert.match(JSON.stringify(llm[0]!.content), /Offline practice — answered on the learner's device/);
		const view = projectView([message]);
		assert.equal(view[0]!.parts[0]!.type, "data-offline-practice");
		assert.match(sessionMarkdown([message], { anchors: false }), /^### Offline practice\n\n\[Offline practice/);
	});
});
