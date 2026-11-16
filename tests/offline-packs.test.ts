/**
 * OFFLINE PACK PINS (offline wave C, 2026-11-16): draft validation and
 * conversion, delete semantics, the pack service (background run → stored
 * on the session, usage on the session's cost, dock rows, abort, one run
 * per session), the material the author sees, pack items answerable
 * through the offline-practice service, and the bundle carrying packs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	deletePack,
	packDraftProblems,
	packFromDraft,
	packsRev,
	packSummaries,
	type OfflinePack,
	type PackDraftItem,
} from "../src/core/offline-packs.ts";
import { createOfflinePacks, packMaterialOf, PackStartError } from "../src/server/offline-packs.ts";
import { createOfflinePractice } from "../src/server/offline-practice.ts";
import { buildOfflineBundle } from "../src/server/offline-bundle.ts";
import { packAuthorPrompt } from "../src/agent/subagents/pack-author.ts";
import { offlinePackTitle } from "../components/new-session.tsx";
import type { ChatRecord, TurnUsage } from "../src/core/contracts/chat.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PendingSitting } from "../src/core/offline-practice.ts";

const quiz = (extra: Partial<Extract<PackDraftItem, { kind: "quiz" }>> = {}): PackDraftItem => ({
	kind: "quiz", question: "Which?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], explanation: "Because A.", correctAnswer: "a", ...extra,
});
const problem = (extra: Partial<Extract<PackDraftItem, { kind: "problem" }>> = {}): PackDraftItem => ({
	kind: "problem", statement: "Show it.", modelSolution: "Step 1. Step 2.", ...extra,
});
const fourItems = (): PackDraftItem[] => [quiz({ target: ["n_1"] }), quiz({ question: "Pick both", options: [{ label: "X" }, { label: "Y" }, { label: "Z" }], correctAnswer: ["X", "Y"], multiSelect: true }), problem(), problem({ mode: "composition", target: ["n_1"] })];

describe("pack drafts", () => {
	it("enforces size, the quiz authoring contract and listed targets", () => {
		assert.deepEqual(packDraftProblems(fourItems(), new Set(["n_1"])), []);
		assert.match(packDraftProblems(fourItems().slice(0, 3), new Set(["n_1"]))[0]!, /4–20 items/);
		assert.ok(packDraftProblems([...fourItems().slice(1), quiz({ correctAnswer: "zzz" })], new Set(["n_1"])).some((p) => /does not match any option/.test(p)));
		assert.ok(packDraftProblems(fourItems(), new Set()).some((p) => /not listed proposition ids/.test(p)));
	});

	it("converts to practice items with pack keys, resolved answers, targets, and a neutral original", () => {
		const pack = packFromDraft("p1", "chat", "2026-11-16T10:00:00.000Z", fourItems());
		assert.deepEqual(pack.items.map((i) => i.key), ["pack:p1:0", "pack:p1:1", "pack:p1:2", "pack:p1:3"]);
		const q0 = pack.items[0]!, q1 = pack.items[1]!, p3 = pack.items[3]!;
		assert.ok(q0.kind === "quiz" && q0.correctValues[0] === "a" && q0.target?.[0] === "n_1" && !q0.multiSelect);
		assert.ok(q1.kind === "quiz" && q1.multiSelect && q1.correctValues.join() === "X,Y");
		assert.ok(p3.kind === "problem" && p3.mode === "composition");
		assert.ok(pack.items.every((i) => i.original === "right" && i.chatId === "chat"));
	});

	it("delete keeps answered items (marked deleted), drops untouched packs; summaries hide deleted ones", () => {
		const a = packFromDraft("a", "c", "2026-11-16T10:00:00.000Z", fourItems());
		const b = packFromDraft("b", "c", "2026-11-16T11:00:00.000Z", fourItems());
		const afterA = deletePack([a, b], "a", new Set(["pack:a:2"]), "2026-11-17T00:00:00.000Z");
		assert.deepEqual(afterA.map((p) => [p.id, p.items.map((i) => i.key), p.deletedAt]), [["a", ["pack:a:2"], "2026-11-17T00:00:00.000Z"], ["b", b.items.map((i) => i.key), undefined]]);
		assert.deepEqual(deletePack([b], "b", new Set(), "x"), []);
		assert.deepEqual(packSummaries("c", afterA).map((s) => [s.id, s.quizzes, s.problems]), [["b", 2, 2]]);
		assert.notEqual(packsRev([a, b]), packsRev(afterA));
	});

	it("titles a pack session from the picks, cut to fit", () => {
		assert.equal(offlinePackTitle(["Chain rule", "Product rule"]), "Offline pack: Chain rule, Product rule");
		const long = offlinePackTitle(["Fundamental theorem of calculus", "Mean value theorem", "Intermediate value theorem"]);
		assert.ok(long.length <= 61 && long.endsWith("…") && long.startsWith("Offline pack: Fundamental theorem of calculus"));
	});
});

function graphContext(): LhMessage {
	return { id: "gc", role: "custom", customType: "graph-context", content: "", display: true, details: { propositions: [{ id: "n_pick", name: "Pick", statement: "Picked statement." }], chains: ["n_pick → n_other"] }, timestamp: 1 } as unknown as LhMessage;
}
const node = (id: string, chatId: string): GraphNode => ({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "x", provenance: [{ chatId, messageId: "m" }] });

describe("pack material", () => {
	it("collects picks + chains, the session's graph propositions, and everything already asked", () => {
		const record: ChatRecord = {
			id: "c", title: "T", createdAt: "x", updatedAt: "x",
			messages: [graphContext(),
				{ id: "a", role: "assistant", content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: quiz() }], timestamp: 2, stopReason: "toolUse" } as unknown as LhMessage,
				{ id: "r", role: "toolResult", toolCallId: "q1", toolName: "quiz", isError: false, content: [], details: { correct: true }, timestamp: 3 } as unknown as LhMessage],
			offlinePacks: [packFromDraft("old", "c", "2026-11-01T00:00:00.000Z", [problem({ statement: "Old pack problem." }), quiz(), quiz(), quiz()])],
		};
		const m = packMaterialOf("c", record, [node("n_mine", "c"), node("n_theirs", "other")]);
		assert.deepEqual(m.propositions.map((p) => p.id), ["n_pick", "n_mine"]);
		assert.deepEqual(m.chains, ["n_pick → n_other"]);
		assert.ok(m.asked.includes("Which?") && m.asked.includes("Old pack problem."));
		const prompt = packAuthorPrompt(m);
		assert.match(prompt, /- \[n_pick\] Pick: Picked statement\./);
		assert.match(prompt, /## Already asked \(do not repeat\)/);
	});
});

function packService(write: () => Promise<PackDraftItem[]>) {
	const chats = new Map<string, ChatRecord>([["c", { id: "c", title: "Calc", createdAt: "x", updatedAt: "x", messages: [] }]]);
	const usage: TurnUsage[] = [];
	let activity = 0;
	const service = createOfflinePacks({
		chatStore: {
			getChat: (id) => chats.get(id) ?? null,
			updateOfflinePacks: (id, update) => { const r = chats.get(id); if (!r) return null; r.offlinePacks = update(r.offlinePacks ?? []); return r.offlinePacks; },
			appendTurnUsage: (_id, entry) => { usage.push(entry); },
		},
		graphNodes: () => [],
		write: async (_m, _c, _s, onStep) => { onStep({ input: 1, output: 2 } as never, "prov:strong"); return write(); },
		toCallUsage: (u) => ({ inputTokens: u.input, outputTokens: u.output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
		answeredKeys: () => new Set(),
		notify: () => {},
		activityChanged: () => { activity++; },
		schedule: () => 0,
	});
	return { service, chats, usage, activity: () => activity };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("pack service", () => {
	it("stores the pack on the session, bills its usage, and clears the dock row", async () => {
		const t = packService(async () => fourItems());
		const run = t.service.start("c");
		assert.deepEqual(t.service.activity().map((r) => [r.id, r.status]), [[run.id, "running"]]);
		assert.throws(() => t.service.start("c"), (e: unknown) => e instanceof PackStartError && e.status === 409);
		assert.throws(() => t.service.start("nope"), (e: unknown) => e instanceof PackStartError && e.status === 404);
		await settle(); await settle();
		const packs = t.chats.get("c")!.offlinePacks!;
		assert.equal(packs.length, 1);
		assert.equal(packs[0]!.items.length, 4);
		assert.equal(t.usage.length, 1);
		assert.equal(t.usage[0]!.messageId, `pack:${packs[0]!.id}`);
		assert.deepEqual(t.service.activity(), []);
	});

	it("keeps a failed run visible with its error (billed too); abort dismisses it", async () => {
		const t = packService(async () => { throw new Error("model refused"); });
		const run = t.service.start("c");
		await settle(); await settle();
		assert.deepEqual(t.service.activity().map((r) => [r.status, r.error]), [["failed", "model refused"]]);
		assert.equal(t.usage.length, 1);
		assert.equal(t.chats.get("c")!.offlinePacks, undefined);
		assert.equal(t.service.abort(run.id), true);
		assert.deepEqual(t.service.activity(), []);
	});

	it("an aborted run stores nothing", async () => {
		let release: (v: PackDraftItem[]) => void = () => {};
		const t = packService(() => new Promise((r) => { release = r; }));
		const run = t.service.start("c");
		t.service.abort(run.id);
		release(fourItems());
		await settle(); await settle();
		assert.equal(t.chats.get("c")!.offlinePacks, undefined);
		assert.deepEqual(t.service.activity(), []);
	});
});

describe("pack items in practice and the bundle", () => {
	const pack: OfflinePack = packFromDraft("pk", "c", "2026-11-16T10:00:00.000Z", fourItems());

	it("pack answers are accepted and recorded with their targets", async () => {
		const chats = new Map<string, ChatRecord>([["c", { id: "c", title: "T", createdAt: "x", updatedAt: "x", messages: [], offlinePacks: [pack] }]]);
		const sittings = new Map<string, PendingSitting>();
		const service = createOfflinePractice({
			chatStore: { getChat: (id) => chats.get(id) ?? null, saveMessages: (id, m) => { chats.get(id)!.messages = m; }, appendTurnUsage: () => {} },
			sittings: { list: () => [...sittings.values()], put: (s) => { sittings.set(s.id, s); }, remove: (id) => { sittings.delete(id); } },
			isSessionBusy: () => false,
			grade: async () => ({ outcome: "solved", verdict: "ok", missClass: null, retest: false }),
			toCallUsage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
			extraItemsOf: (id) => chats.get(id)?.offlinePacks?.flatMap((p) => p.items) ?? [],
			schedule: () => 0, cancel: () => {},
		});
		const res = service.accept([{ id: "x1", itemKey: "pack:pk:0", chatId: "c", kind: "quiz", answeredAt: "2026-11-16T12:00:00Z", selected: ["a"], correct: true }]);
		assert.deepEqual(res.accepted, ["x1"]);
		await service.kick();
		const content = (chats.get("c")!.messages.at(-1) as { content: string }).content;
		assert.match(content, /1\. Quiz \[targets: n_1\]: "Which\?"\n {3}Learner chose: "A" — correct/);
	});

	it("the bundle carries pack items + summaries and re-sends when packs change", () => {
		const record: ChatRecord = { id: "c", title: "T", createdAt: "x", updatedAt: "2026-11-16T00:00:00Z", messages: [], offlinePacks: [pack] };
		const deps = (rev: string) => ({
			chatStore: {
				listChats: () => [{ id: "c", title: "T", createdAt: "x", updatedAt: record.updatedAt, kind: "teach" as const, messageCount: 0, phase: "probe" as never, pendingQuestion: false, pendingProblem: false, offlinePacksRev: rev }],
				getChat: () => record,
			},
			sourceTextStore: { read: () => null },
			readSourceDirectory: () => ({ organization: { version: 1 as const, folders: [], placements: {} }, sources: [] }),
		});
		const first = buildOfflineBundle({ sessions: {}, notes: {} }, deps(packsRev([pack])));
		const doc = first.sessions[0]!;
		assert.deepEqual(doc.practice.map((i) => i.key), pack.items.map((i) => i.key));
		assert.deepEqual(doc.packs.map((p) => [p.id, p.quizzes, p.problems]), [["pk", 2, 2]]);
		const held = { sessions: { c: doc.rev }, notes: {} };
		assert.equal(buildOfflineBundle(held, deps(packsRev([pack]))).sessions.length, 0);
		assert.equal(buildOfflineBundle(held, deps("changed")).sessions.length, 1);
	});
});
