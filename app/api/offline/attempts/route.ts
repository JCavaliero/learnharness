/**
 * POST /api/offline/attempts (offline wave B, 2026-11-16) — the device's
 * offline answers. Body: { attempts: DeviceAttempt[] }. Answer:
 * { accepted: id[], rejected: {id, reason}[] }. Re-sending an attempt the
 * server already holds is accepted again (idempotent by attempt id).
 */
import { offlinePractice } from "@/src/server";
import { parseAttemptUpload } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	let attempts;
	try { attempts = parseAttemptUpload(await request.json()); }
	catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	return Response.json(offlinePractice.accept(attempts), { headers: { "Cache-Control": "no-store" } });
}
