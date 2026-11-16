/**
 * OFFLINE COPY PINS (offline wave A, 2026-11-16): the device ⇄ server delta
 * contract (core/offline.ts), the bundle builder (server/offline-bundle.ts),
 * reading-mode session markdown, the notes text snapshots and their removal
 * with the source. Runs under an isolated LH_DATA_DIR (set before any
 * config-loading import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-offline-copy-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const { applyOfflineBundle, offlineBundleRequestOf, parseOfflineBundleRequest, offlineSessionsInOrder } = await import("../src/core/offline.ts");
const { buildOfflineBundle } = await import("../src/server/offline-bundle.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { sourceTextStore } = await import("../src/store/source-text.ts");
const { notesSourceId } = await import("../src/server/notes-source-id.ts");
const { stores } = await import("../src/server/stores.ts");
const { SOURCE_TEXT_DIR } = await import("../config.ts");
const { DELETE } = await import("../app/api/graph/sources/route.ts");
const { POST } = await import("../app/api/offline/bundle/route.ts");
type Bundle = import("../src/core/offline.ts").OfflineBundle;
type Copy = import("../src/core/offline.ts").OfflineCopy;
type ChatRecord = import("../src/core/contracts/chat.ts").ChatRecord;
type ChatSummary = import("../src/core/contracts/chat.ts").ChatSummary;
type SourceDirectory = import("../src/core/source-organization.ts").SourceDirectory;

after(() => fs.rmSync(root, { recursive: true, force: true }));

const quizCall = {
	id: "a1", role: "assistant", timestamp: 1,
	content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "2+2?", options: [{ label: "4" }, { label: "5" }], explanation: "Counting.", correctAnswer: "4" } }],
};
const quizResult = {
	id: "r1", role: "toolResult", toolCallId: "q1", toolName: "quiz", isError: false, timestamp: 2, content: [{ type: "text", text: "{}" }],
	details: {
		kind: "quiz", questionText: "2+2?", options: [{ index: 1, label: "4" }, { index: 2, label: "5" }],
		dontKnow: false, answers: [{ index: 2, label: "5", value: "5" }], correct: false, correctIndices: [1],
		explanation: "Counting.", answeredAt: "2026-11-16T00:00:00.000Z",
	},
};

function record(id: string, title: string, updatedAt: string, messages: unknown[] = []): ChatRecord {
	return { id, title, createdAt: "2026-11-01T00:00:00.000Z", updatedAt, messages: messages as ChatRecord["messages"] };
}
function summary(r: ChatRecord): ChatSummary {
	return { id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, kind: r.kind ?? "teach", messageCount: r.messages.length, phase: "probe" as ChatSummary["phase"], pendingQuestion: false, pendingProblem: false };
}
function fakeDeps(chats: ChatRecord[], notes: { id: string; label: string; filePath: string; createdAt: string }[], texts: Record<string, string>) {
	return {
		chatStore: { listChats: () => chats.map(summary), getChat: (id: string) => chats.find((c) => c.id === id) ?? null },
		sourceTextStore: { read: (id: string) => texts[id] ?? null },
		readSourceDirectory: (): SourceDirectory => ({
			organization: { version: 1, folders: [], placements: {} },
			sources: notes.map((n) => ({ id: n.id, kind: "notes" as const, label: n.label, filePath: n.filePath, createdAt: n.createdAt })),
		}),
		now: () => new Date("2026-11-16T12:00:00.000Z"),
	};
}

describe("offline copy contract", () => {
	it("parses held revs and refuses malformed requests", () => {
		assert.deepEqual(parseOfflineBundleRequest({}), { sessions: {}, notes: {} });
		assert.deepEqual(parseOfflineBundleRequest({ sessions: { a: "1" }, notes: { b: "2" } }), { sessions: { a: "1" }, notes: { b: "2" } });
		assert.throws(() => parseOfflineBundleRequest({ sessions: [] }));
		assert.throws(() => parseOfflineBundleRequest({ notes: { b: 2 } }));
	});

	it("applies a bundle into a new copy: removals, upserts, input untouched", () => {
		const doc = (id: string, updatedAt: string) => ({ id, title: id, kind: "teach" as const, createdAt: updatedAt, updatedAt, rev: id + updatedAt, markdown: "", practice: [], attempts: [] });
		const copy: Copy = { sessions: new Map([["old", doc("old", "2026-01-01")], ["keep", doc("keep", "2026-01-02")]]), notes: new Map() };
		const bundle: Bundle = { generatedAt: "now", sessions: [doc("new", "2026-01-03")], notes: [], removedSessions: ["old"], removedNotes: [], pendingAttempts: [] };
		const next = applyOfflineBundle(copy, bundle);
		assert.deepEqual(offlineSessionsInOrder(next).map((s) => s.id), ["new", "keep"]);
		assert.ok(copy.sessions.has("old"), "the input copy is not mutated");
		assert.deepEqual(offlineBundleRequestOf(next).sessions, { new: "new2026-01-03", keep: "keep2026-01-02" });
	});

	it("builds a full first bundle, an empty second one, and re-sends renamed/updated sessions and removed ids", () => {
		const chats = [record("c1", "Derivatives", "2026-11-10T00:00:00.000Z", [quizCall, quizResult]), record("c2", "Limits", "2026-11-11T00:00:00.000Z")];
		const notes = [{ id: "src_aaaaaaaaaaaa", label: "Notes A", filePath: "a.md", createdAt: "2026-11-01" }, { id: "src_bbbbbbbbbbbb", label: "Notes B", filePath: "b.md", createdAt: "2026-11-02" }];
		const texts: Record<string, string> = { src_aaaaaaaaaaaa: "# A" };
		const first = buildOfflineBundle({ sessions: {}, notes: {} }, fakeDeps(chats, notes, texts));
		assert.equal(first.generatedAt, "2026-11-16T12:00:00.000Z");
		assert.deepEqual(first.sessions.map((s) => s.id).sort(), ["c1", "c2"]);
		assert.match(first.sessions.find((s) => s.id === "c1")!.markdown, /\*\*Explanation:\*\* Counting\./);
		assert.deepEqual(first.sessions.find((s) => s.id === "c1")!.practice.map((p) => [p.key, p.kind, p.original]), [["c1:q1", "quiz", "wrong"]]);
		assert.deepEqual(first.pendingAttempts, []);
		assert.equal(first.notes.find((n) => n.id === "src_aaaaaaaaaaaa")!.markdown, "# A");
		assert.equal(first.notes.find((n) => n.id === "src_bbbbbbbbbbbb")!.markdown, null);

		const held = { sessions: Object.fromEntries(first.sessions.map((s) => [s.id, s.rev])), notes: Object.fromEntries(first.notes.map((n) => [n.id, n.rev])) };
		const quiet = buildOfflineBundle(held, fakeDeps(chats, notes, texts));
		assert.deepEqual([quiet.sessions, quiet.notes, quiet.removedSessions, quiet.removedNotes], [[], [], [], []]);

		chats[1]!.title = "Limits (renamed)"; // a rename does not bump updatedAt
		texts.src_bbbbbbbbbbbb = "# B"; // a snapshot appears
		const delta = buildOfflineBundle({ ...held, sessions: { ...held.sessions, gone: "x" } }, fakeDeps([chats[1]!], notes, texts));
		assert.deepEqual(delta.sessions.map((s) => s.title), ["Limits (renamed)"]);
		assert.deepEqual(delta.removedSessions.sort(), ["c1", "gone"]);
		assert.deepEqual(delta.notes.map((n) => [n.id, n.markdown]), [["src_bbbbbbbbbbbb", "# B"]]);
	});

	it("the route answers a delta and refuses malformed bodies", async () => {
		const bad = await POST(new Request("http://localhost/api/offline/bundle", { method: "POST", body: JSON.stringify({ sessions: [] }) }));
		assert.equal(bad.status, 400);
		const chat = stores.chatStore.createChat("Route fixture");
		const res = await POST(new Request("http://localhost/api/offline/bundle", { method: "POST", body: JSON.stringify({ sessions: { ghost: "r" } }) }));
		assert.equal(res.status, 200);
		const bundle = await res.json() as Bundle;
		assert.ok(bundle.sessions.some((s) => s.id === chat.id && s.markdown.startsWith("# Route fixture")));
		assert.deepEqual(bundle.removedSessions, ["ghost"]);
	});
});

describe("reading-mode session markdown", () => {
	it("adds options (correct + your pick) and the explanation; the default document is unchanged", () => {
		const messages = [quizCall, quizResult] as never;
		const reading = sessionMarkdown(messages, { anchors: false, reading: true });
		assert.match(reading, /- ✓ 4\n- 5 \*\(your answer\)\*/);
		assert.match(reading, /\*\*Explanation:\*\* Counting\./);
		const plain = sessionMarkdown(messages, { anchors: false });
		assert.doesNotMatch(plain, /Explanation|your answer|✓/);
		assert.equal(reading.startsWith(plain), true, "reading mode only appends to the quiz block");
	});
});

describe("notes text snapshots", () => {
	it("write/read/remove by source id; malformed ids never touch disk", () => {
		const id = notesSourceId("folder/notes.md");
		assert.match(id, /^src_[0-9a-f]{12}$/);
		sourceTextStore.write(id, "snapshot text");
		assert.equal(sourceTextStore.read(id), "snapshot text");
		assert.equal(fs.existsSync(path.join(SOURCE_TEXT_DIR, `${id}.md`)), true);
		assert.equal(sourceTextStore.read("../escape"), null);
		assert.throws(() => sourceTextStore.write("../escape", "x"));
		sourceTextStore.remove(new Set([id]));
		assert.equal(sourceTextStore.read(id), null);
	});

	it("deleting a notes source removes its snapshot", async () => {
		const id = notesSourceId("deleted.md");
		stores.graphStore.upsertSource({ id, filePath: "deleted.md", importedAt: "2026-11-16" });
		stores.sourceTextStore.write(id, "to be removed");
		const res = await DELETE(new Request("http://localhost/api/graph/sources", { method: "DELETE", body: JSON.stringify({ sourceIds: [id], folderIds: [], deleteSessions: false }) }));
		assert.equal(res.status, 200);
		assert.equal(stores.sourceTextStore.read(id), null);
	});
});
