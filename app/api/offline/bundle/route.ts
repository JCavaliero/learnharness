/**
 * POST /api/offline/bundle (offline wave A, 2026-11-16) — the device's
 * offline copy delta. Body: { sessions: {id: rev}, notes: {id: rev} } — what
 * the device holds. Answer: changed/new sessions (reading-mode markdown) and
 * notes (import-time snapshots) in full, plus the ids that no longer exist.
 * See src/core/offline.ts. POST, not GET: the held-rev map can be long.
 */
import { buildOfflineBundle, offlinePractice, sourceDirectory, stores } from "@/src/server";
import { parseOfflineBundleRequest } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	let known;
	try { known = parseOfflineBundleRequest(await request.json()); }
	catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	const bundle = buildOfflineBundle(known, {
		chatStore: stores.chatStore,
		sourceTextStore: stores.sourceTextStore,
		readSourceDirectory: () => sourceDirectory.read(),
		pendingAttempts: () => offlinePractice.pendingAttemptRecords(),
	});
	return Response.json(bundle, { headers: { "Cache-Control": "no-store" } });
}
