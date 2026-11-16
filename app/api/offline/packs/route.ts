/**
 * Offline practice packs (offline wave C, 2026-11-16).
 *
 * POST   { chatId }            → start making a pack for the session (the
 *                                strong-slot author runs in the background;
 *                                progress in the activity dock). 404 unknown
 *                                session, 409 a pack is already being made.
 * DELETE ?chatId=…&packId=…    → delete a pack's unanswered items (answered
 *                                ones stay in the queue and in history).
 */
import { offlinePacks, PackStartError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { chatId?: unknown } | null;
	if (typeof body?.chatId !== "string" || !body.chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
	try {
		const run = offlinePacks.start(body.chatId);
		return Response.json({ runId: run.id });
	} catch (err) {
		if (err instanceof PackStartError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

export async function DELETE(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const chatId = url.searchParams.get("chatId");
	const packId = url.searchParams.get("packId");
	if (!chatId || !packId) return Response.json({ error: "chatId and packId are required" }, { status: 400 });
	const packs = offlinePacks.remove(chatId, packId);
	if (packs === null) return Response.json({ error: "Session not found" }, { status: 404 });
	return Response.json({ ok: true });
}
