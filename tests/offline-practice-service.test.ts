/**
 * OFFLINE PRACTICE SERVICE PINS (offline wave B, 2026-11-16): uploads are
 * checked + re-graded against the record, idempotent per attempt id;
 * sittings grade with 1/5/15-minute retries then fail until Retry; a
 * graded sitting is appended as one history message only while the
 * session is idle, with the grader's usage on the session's cost log.
 * In-memory stores, a fake grader, a controllable clock, no timers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOfflinePractice } from "../src/server/offline-practice.ts";
import type { ChatRecord, TurnUsage } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { DeviceAttempt, GraderVerdict, PendingSitting } from "../src/core/offline-practice.ts";

let n = 0;
const id = () => `m${++n}`;
function call(name: string, callId: string, args: Record<string, unknown>): LhMessage {
	return { id: id(), role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 1, stopReason: "toolUse" } as unknown as LhMessage;
}
function result(name: string, callId: string, details: unknown = null): LhMessage {
	return { id: id(), role: "toolResult", toolCallId: callId, toolName: name, isError: false, content: [{ type: "text", text: "{}" }], details, timestamp: 2 } as unknown as LhMessage;
}
const baseMessages = (): LhMessage[] => [
	call("quiz", "q1", { question: "2+2?", options: [{ label: "4", value: "four" }, { label: "5", value: "five" }], explanation: "Counting.", correctAnswer: "four" }),
	result("quiz", "q1", { kind: "quiz", correct: false }),
	call("problem", "p1", { statement: "Prove it.", modelSolution: "Because." }), result("problem", "p1"),
	call("conclude", "c1", { outcome: "movedOn", verdict: "no" }), result("conclude", "c1"),
];

function setup(opts: { busy?: () => boolean; grade?: () => Promise<GraderVerdict> } = {}) {
	let clock = Date.parse("2026-11-16T12:00:00Z");
	const chats = new Map<string, ChatRecord>([["c", { id: "c", title: "T", createdAt: "x", updatedAt: "x", messages: baseMessages() }]]);
	const usage: { chatId: string; entry: TurnUsage }[] = [];
	const sittings = new Map<string, PendingSitting>();
	const notified: string[] = [];
	let gradeCalls = 0;
	const service = createOfflinePractice({
		chatStore: {
			getChat: (cid) => (chats.has(cid) ? structuredClone(chats.get(cid)!) : null),
			saveMessages: (cid, messages) => { chats.get(cid)!.messages = messages; },
			appendTurnUsage: (cid, entry) => { usage.push({ chatId: cid, entry }); },
		},
		sittings: {
			list: () => [...sittings.values()].map((s) => structuredClone(s)),
			put: (s) => { sittings.set(s.id, structuredClone(s)); },
			remove: (sid) => { sittings.delete(sid); },
		},
		isSessionBusy: () => opts.busy?.() ?? false,
		grade: async (_input, _chatId, onStep) => {
			gradeCalls++;
			onStep({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as never, "prov:cheap");
			return opts.grade ? opts.grade() : { outcome: "solved", verdict: "Right.", missClass: null, retest: false };
		},
		toCallUsage: (u) => ({ inputTokens: u.input, outputTokens: u.output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
		notify: (cid) => notified.push(cid),
		now: () => clock,
		schedule: () => 0,
		cancel: () => {},
	});
	return { service, chats, usage, sittings, notified, advance: (ms: number) => { clock += ms; }, gradeCalls: () => gradeCalls };
}
const quiz = (aid: string, selected: string[], correct = true): DeviceAttempt =>
	({ id: aid, itemKey: "c:q1", chatId: "c", kind: "quiz", answeredAt: "2026-11-15T09:00:00Z", selected, correct });
const problem = (aid: string): DeviceAttempt =>
	({ id: aid, itemKey: "c:p1", chatId: "c", kind: "problem", answeredAt: "2026-11-15T10:00:00Z", answer: "my proof" });
const offlineMessages = (chats: Map<string, ChatRecord>) => chats.get("c")!.messages.filter((m) => m.role === "custom" && m.customType === "offline-practice");

describe("offline practice service", () => {
	it("re-grades quizzes server-side, rejects unknown items/sessions, and appends a quiz-only sitting at once", async () => {
		const t = setup();
		const res = t.service.accept([
			quiz("a1", ["five"], true), // the device claims right; the record says wrong
			{ ...quiz("a2", ["four"]), itemKey: "c:nope" },
			{ ...quiz("a3", ["four"]), chatId: "gone", itemKey: "gone:q1" },
			{ ...quiz("a4", ["six"]) },
		]);
		assert.deepEqual(res.accepted, ["a1"]);
		assert.deepEqual(res.rejected.map((r) => [r.id, r.reason]).sort(), [["a2", "item not found"], ["a3", "session not found"], ["a4", "unknown option"]]);
		await t.service.kick();
		const added = offlineMessages(t.chats);
		assert.equal(added.length, 1);
		assert.match((added[0] as { content: string }).content, /Learner chose: "5" \(?.*incorrect \(correct: "4"\)/);
		assert.equal(t.sittings.size, 0);
		assert.equal(t.usage.length, 0);
	});

	it("is idempotent: a re-upload of a pending or recorded attempt is accepted without a new sitting", async () => {
		const t = setup({ busy: () => true });
		t.service.accept([quiz("a1", ["four"])]);
		assert.deepEqual(t.service.accept([quiz("a1", ["four"])]).accepted, ["a1"]);
		assert.equal(t.sittings.size, 1);
		const t2 = setup();
		t2.service.accept([quiz("a1", ["four"])]);
		await t2.service.kick();
		assert.deepEqual(t2.service.accept([quiz("a1", ["four"])]).accepted, ["a1"]);
		assert.equal(t2.sittings.size, 0);
		assert.equal(offlineMessages(t2.chats).length, 1);
	});

	it("grades problems, logs grader usage on the session keyed to the new message, and waits while the session is busy", async () => {
		let busy = true;
		const t = setup({ busy: () => busy });
		t.service.accept([problem("p-a"), quiz("q-a", ["four"])]);
		await t.service.kick();
		assert.equal(t.gradeCalls(), 1);
		assert.equal([...t.sittings.values()][0]!.status, "waiting");
		assert.deepEqual(t.service.pendingAttemptRecords().map((r) => [r.id, r.result, r.status]).sort(), [["p-a", "right", "waiting"], ["q-a", "right", "waiting"]]);
		assert.equal(offlineMessages(t.chats).length, 0, "busy session: nothing appended");
		busy = false;
		await t.service.kick();
		const [message] = offlineMessages(t.chats);
		assert.ok(message);
		assert.equal(t.usage.length, 1);
		assert.equal(t.usage[0]!.entry.messageId, message.id);
		assert.equal(t.usage[0]!.entry.model, "prov:cheap");
		assert.equal(t.chats.get("c")!.messages.at(-1), message, "appended at the tail");
	});

	it("holds while a question is pending in the record", async () => {
		const t = setup();
		t.chats.get("c")!.messages.push(call("quiz", "q9", { question: "?", options: [{ label: "a" }, { label: "b" }], explanation: "", correctAnswer: "a" }));
		t.service.accept([quiz("a1", ["four"])]);
		await t.service.kick();
		assert.equal(offlineMessages(t.chats).length, 0);
		assert.equal([...t.sittings.values()][0]!.status, "waiting");
	});

	it("retries grading at 1/5/15 minutes, then fails until Retry", async () => {
		let fail = true;
		const t = setup({ grade: async () => { if (fail) throw new Error("provider down"); return { outcome: "movedOn", verdict: "Close.", missClass: "execution", retest: true }; } });
		t.service.accept([problem("p-a")]);
		await t.service.kick();
		const s = () => [...t.sittings.values()][0]!;
		assert.deepEqual([s().status, s().tries, s().nextTryAt], ["grading", 1, "2026-11-16T12:01:00.000Z"]);
		await t.service.kick();
		assert.equal(s().tries, 1, "not retried before nextTryAt");
		for (const minutes of [1, 5, 15]) { t.advance(minutes * 60_000); await t.service.kick(); }
		assert.deepEqual([s().status, s().tries, s().lastError], ["failed", 4, "provider down"]);
		assert.equal(t.service.sittingsOf("c")[0]!.status, "failed");
		fail = false;
		assert.equal(t.service.retry(s().id), true);
		await t.service.kick();
		assert.equal(t.sittings.size, 0);
		assert.match((offlineMessages(t.chats)[0] as { content: string }).content, /Graded: moved on — "Close\." \(miss: execution; retest: yes\)/);
		assert.equal(t.usage.length, 5, "every grader call is billed, failed rounds included");
	});
});
