/**
 * GET /api/offline/sittings?chatId=… (offline wave B) — the session's
 * offline sittings still on the server: grading, waiting for the session
 * to be idle, or failed (the transcript notice + Retry).
 */
import { offlinePractice } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	const chatId = new URL(request.url).searchParams.get("chatId");
	if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
	return Response.json({ sittings: offlinePractice.sittingsOf(chatId) }, { headers: { "Cache-Control": "no-store" } });
}
