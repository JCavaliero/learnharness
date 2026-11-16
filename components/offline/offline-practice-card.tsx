"use client";

/**
 * Transcript pieces for offline practice (offline wave B, 2026-11-16):
 *
 * - OfflinePracticeCard: one graded offline sitting in a session's
 *   history — each answer with its result; quiz explanations and model
 *   solutions fold open.
 * - OfflineResultsNotice: the bottom-of-transcript line when grading of
 *   this session's offline answers gave up, with Retry (owner: bottom of
 *   the transcript).
 */
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, ChevronRightIcon, WifiOffIcon, XIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { MarkdownDisplayOnlyContext } from "@/components/md-blocks";
import { Button } from "@/components/ui/button";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { formatDateRange, readOfflinePracticeDetails, type OfflinePracticeEntry } from "@/src/core";

function Md({ children }: { children: string }) {
	return (
		<MarkdownDisplayOnlyContext.Provider value={true}>
			<ToolContentResponse>{children}</ToolContentResponse>
		</MarkdownDisplayOnlyContext.Provider>
	);
}

const OUTCOME_LABEL = { solved: "Solved", movedOn: "Missed", surrendered: "Surrendered" } as const;

export function OfflinePracticeCard({ data }: { data: unknown }) {
	const details = readOfflinePracticeDetails(data);
	const [open, setOpen] = useState(false);
	if (!details || details.entries.length === 0) return null;
	const times = details.entries.map((e) => e.answeredAt).sort();
	const right = details.entries.filter((e) => (e.kind === "quiz" ? e.correct : e.grade.outcome === "solved")).length;
	return (
		<section data-testid="offline-practice-card" className="my-4 rounded-lg border border-border bg-card/40">
			<button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
				<ChevronRightIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
				<WifiOffIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				<span className="font-medium">Offline practice</span>
				<span className="text-muted-foreground">
					· {details.entries.length} {details.entries.length === 1 ? "answer" : "answers"} · {right} right · {formatDateRange(times[0]!, times[times.length - 1]!)}
				</span>
			</button>
			{open && (
				<ol className="flex flex-col divide-y divide-border border-t border-border">
					{details.entries.map((e) => <Entry key={e.attemptId} entry={e} />)}
				</ol>
			)}
		</section>
	);
}

function Entry({ entry: e }: { entry: OfflinePracticeEntry }) {
	const [more, setMore] = useState(false);
	const ok = e.kind === "quiz" ? e.correct : e.grade.outcome === "solved";
	return (
		<li className="flex flex-col gap-2 px-3 py-3 text-[15px]">
			<div className="flex items-start gap-2">
				{ok ? <CheckIcon className="mt-1 size-4 shrink-0 text-success" aria-label="right" /> : <XIcon className="mt-1 size-4 shrink-0 text-error" aria-label="missed" />}
				<div className="min-w-0 flex-1"><Md>{e.kind === "quiz" ? e.question : e.statement}</Md></div>
			</div>
			{e.kind === "quiz" ? (
				<p className="pl-6 text-sm text-muted-foreground">
					{e.dontKnow ? "You said you didn't know" : `You chose ${e.chosen.length ? e.chosen.join(", ") : "nothing"}`}
					{e.confidence !== undefined ? ` (confidence ${e.confidence}%)` : ""}
					{e.correct ? "" : ` — correct: ${e.correctLabels.join(", ")}`}
				</p>
			) : (
				<div className="pl-6 text-sm">
					<p className="whitespace-pre-wrap text-muted-foreground">{e.answer || "(blank)"}</p>
					<p className="mt-1"><span className="font-medium">{OUTCOME_LABEL[e.grade.outcome]}.</span> {e.grade.verdict}</p>
				</div>
			)}
			{(e.kind === "quiz" ? e.explanation : e.modelSolution) && (
				<div className="pl-6">
					<button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setMore((m) => !m)}>
						{more ? "Hide" : e.kind === "quiz" ? "Explanation" : "Model solution"}
					</button>
					{more && <div className="mt-2"><Md>{e.kind === "quiz" ? e.explanation : e.modelSolution}</Md></div>}
				</div>
			)}
		</li>
	);
}

interface SittingSummary { id: string; status: "grading" | "waiting" | "failed"; attempts: number; lastError?: string }

export function OfflineResultsNotice({ chatId }: { chatId: string }) {
	const [sittings, setSittings] = useState<SittingSummary[]>([]);
	const [retrying, setRetrying] = useState(false);
	const load = useCallback(() => {
		void fetch(`/api/offline/sittings?chatId=${encodeURIComponent(chatId)}`, { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : { sittings: [] }))
			.then((body: { sittings: SittingSummary[] }) => setSittings(body.sittings))
			.catch(() => {});
	}, [chatId]);
	useEffect(load, [load]);
	useServerEvent("record-changed", (p) => { if (p.chatId === chatId) load(); });
	const failed = sittings.filter((s) => s.status === "failed");
	if (failed.length === 0) return null;
	return (
		<div role="status" data-testid="offline-results-failed" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
			<span>Offline results: grading failed{failed[0]!.lastError ? ` (${failed[0]!.lastError})` : ""}.</span>
			<Button
				variant="outline"
				size="xs"
				disabled={retrying}
				onClick={async () => {
					setRetrying(true);
					try { await Promise.all(failed.map((s) => fetch(`/api/offline/sittings/${encodeURIComponent(s.id)}/retry`, { method: "POST" }))); }
					finally { setRetrying(false); load(); }
				}}
			>
				Retry
			</Button>
		</div>
	);
}
