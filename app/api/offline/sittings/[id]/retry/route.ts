/** POST /api/offline/sittings/:id/retry (offline wave B) — restart grading
 *  of a sitting whose retries ran out. 404 when no failed sitting has it. */
import { offlinePractice } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return offlinePractice.retry(id)
		? Response.json({ ok: true })
		: Response.json({ error: "No failed sitting with that id" }, { status: 404 });
}
