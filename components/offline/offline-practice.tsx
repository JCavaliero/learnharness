"use client";

/**
 * The offline Practice tab (offline wave B, owner 2026-11-16).
 *
 * - The mixed Leitner queue over every session's items: due reviews, then
 *   never-retried items (missed first). Runs of 20 (owner), then a summary
 *   with Continue. Nothing due → "Practice ahead".
 * - "Practice this session" (from the reader): that session's items in
 *   transcript order, same runs of 20.
 * - Quizzes grade instantly (shuffled options, "I don't know", the
 *   confidence slider) and show the explanation. Free-form answers are
 *   saved for the server's grader; their solution stays hidden until graded.
 * - Results: the last 50 free-form answers and where each one stands.
 *
 * Works the same online (the sidebar's Review entry): answers upload and
 * grade right away when the computer is reachable.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { MarkdownDisplayOnlyContext } from "@/components/md-blocks";
import { Button } from "@/components/ui/button";
import { confidenceRailStyle, CONFIDENCE_COLORS } from "@/components/confidence-rail";
import { cn } from "@/lib/utils";
import {
	CONFIDENCE_STOPS,
	DEFAULT_CONFIDENCE_INDEX,
	gradeQuizSelection,
	leitnerStates,
	mergeAttemptRecords,
	nextDueAt,
	practiceQueue,
	shuffleOptions,
	type AttemptRecord,
	type OfflineCopy,
	type PracticeItem,
	type ProblemPracticeItem,
	type QuizPracticeItem,
} from "@/src/core";
import { listLocalAttempts, loadPendingAttempts, saveLocalAttempt, type LocalAttempt } from "./offline-db";
import { getOfflineStatus, noteOfflineCopyChanged, syncOfflineCopy, useOfflineStatus } from "./offline-sync";

export const RUN_LENGTH = 20;
const RESULTS_SHOWN = 50;

function Markdown({ children }: { children: string }) {
	return (
		<MarkdownDisplayOnlyContext.Provider value={true}>
			<ToolContentResponse>{children}</ToolContentResponse>
		</MarkdownDisplayOnlyContext.Provider>
	);
}

function formatWhen(ms: number | string): string {
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Everything the tab needs from storage, reloaded on every copy change. */
export function usePracticeData(copy: OfflineCopy) {
	const status = useOfflineStatus();
	const [server, setServer] = useState<AttemptRecord[]>([]);
	const [local, setLocal] = useState<LocalAttempt[]>([]);
	useEffect(() => {
		let cancelled = false;
		void Promise.all([loadPendingAttempts(), listLocalAttempts()])
			.then(([p, l]) => { if (!cancelled) { setServer(p); setLocal(l); } })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [status.copyVersion]);
	return useMemo(() => {
		const items = [...copy.sessions.values()].flatMap((s) => s.practice ?? []);
		const recorded = [...copy.sessions.values()].flatMap((s) => s.attempts ?? []);
		const attempts = mergeAttemptRecords(recorded, server, local);
		return { items, attempts, states: leitnerStates(items, attempts) };
	}, [copy, server, local]);
}

export type PracticeData = ReturnType<typeof usePracticeData>;

export function PracticeTab({ data, onRun }: { data: PracticeData; onRun: (mode: "review" | "ahead") => void }) {
	const { items, attempts, states } = data;
	const now = Date.now();
	const due = useMemo(() => practiceQueue(items, states, now), [items, states, now]);
	const next = nextDueAt(states, now);
	const itemsByKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
	const results = useMemo(
		() => attempts.filter((a) => a.kind === "problem").sort((a, b) => b.answeredAt.localeCompare(a.answeredAt)).slice(0, RESULTS_SHOWN),
		[attempts],
	);

	if (items.length === 0) {
		return <p className="text-sm text-muted-foreground">No practice questions saved on this device yet. Quizzes and practice problems from your sessions appear here after a sync.</p>;
	}
	return (
		<div className="flex flex-col gap-6" data-testid="offline-practice-tab">
			<section className="rounded-lg border border-border p-4">
				{due.length > 0 ? (
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-sm"><span className="font-medium">{due.length}</span> due for review</p>
						<Button type="button" onClick={() => onRun("review")} data-testid="offline-start-review">Start review</Button>
					</div>
				) : (
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-sm">All caught up{next !== null ? <span className="text-muted-foreground"> — next due {formatWhen(next)}</span> : null}</p>
						<Button type="button" variant="outline" onClick={() => onRun("ahead")} data-testid="offline-practice-ahead">
							Practice ahead
						</Button>
					</div>
				)}
			</section>

			<section>
				<h2 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Your written answers</h2>
				{results.length === 0 ? (
					<p className="text-sm text-muted-foreground">None yet.</p>
				) : (
					<ul className="divide-y divide-border" data-testid="offline-results">
						{results.map((a) => <ResultRow key={a.id} attempt={a} item={itemsByKey.get(a.itemKey)} />)}
					</ul>
				)}
			</section>
		</div>
	);
}

const STATUS_TEXT: Record<AttemptRecord["status"], string> = {
	local: "Saved on this device — waiting to upload",
	grading: "Grading…",
	waiting: "Graded — added to the session when it's free",
	failed: "Grading failed — retry from the session",
	recorded: "Graded",
};

function ResultRow({ attempt, item }: { attempt: AttemptRecord; item: PracticeItem | undefined }) {
	const [open, setOpen] = useState(false);
	const problem = item?.kind === "problem" ? item : undefined;
	const grade = attempt.grade;
	const statusText = attempt.status === "local" && getOfflineStatus().reachable !== false ? "Uploading…" : STATUS_TEXT[attempt.status];
	return (
		<li className="py-3">
			<button type="button" className="flex w-full flex-col items-start gap-0.5 text-left" onClick={() => setOpen((o) => !o)} disabled={!grade}>
				<span className="line-clamp-2 text-sm">{problem?.statement ?? "(question no longer available)"}</span>
				<span className="text-xs text-muted-foreground">
					{formatWhen(attempt.answeredAt)} · {grade ? `${grade.outcome === "solved" ? "Solved" : grade.outcome === "movedOn" ? "Missed" : "Surrendered"}${open ? "" : " — show"}` : statusText}
				</span>
			</button>
			{open && grade && (
				<div className="mt-3 flex flex-col gap-3 text-[15px]">
					<div><p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">Your answer</p><p className="whitespace-pre-wrap">{attempt.answer || "(blank)"}</p></div>
					<div><p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">Verdict</p><Markdown>{grade.verdict}</Markdown></div>
					{problem && <div><p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">Model solution</p><Markdown>{problem.modelSolution}</Markdown></div>}
				</div>
			)}
		</li>
	);
}

// ─── a run ──────────────────────────────────────────────────────────────────

export function PracticeRun({ label, onExit, nextItems }: {
	label: string;
	onExit: () => void;
	/** The candidates for the next run, given the keys already served
	 *  (fresh Leitner state on every call). */
	nextItems: (served: ReadonlySet<string>) => PracticeItem[];
}) {
	const [first] = useState(() => nextItems(new Set()).slice(0, RUN_LENGTH));
	const [served, setServed] = useState<Set<string>>(() => new Set(first.map((i) => i.key)));
	const [run, setRun] = useState<PracticeItem[]>(first);
	const [index, setIndex] = useState(0);
	const [tally, setTally] = useState({ right: 0, wrong: 0, written: 0 });
	const current = run[index];

	const record = async (attempt: LocalAttempt) => {
		await saveLocalAttempt(attempt);
		setTally((t) => attempt.kind === "problem"
			? { ...t, written: t.written + 1 }
			: attempt.correct ? { ...t, right: t.right + 1 } : { ...t, wrong: t.wrong + 1 });
		noteOfflineCopyChanged();
		if (getOfflineStatus().reachable !== false) void syncOfflineCopy();
	};

	if (run.length === 0) {
		return (
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">Nothing to practice here.</p>
				<Button type="button" variant="outline" className="self-start" onClick={onExit}>Back</Button>
			</div>
		);
	}
	if (!current) {
		const more = nextItems(served);
		return (
			<div className="flex flex-col gap-4" data-testid="offline-run-summary">
				<h2 className="font-title text-xl">{label} — done</h2>
				<p className="text-sm">
					Quizzes: {tally.right} right, {tally.wrong} missed.
					{tally.written > 0 && ` ${tally.written} written ${tally.written === 1 ? "answer is" : "answers are"} waiting to be graded.`}
				</p>
				<div className="flex gap-2">
					{more && more.length > 0 && (
						<Button type="button" onClick={() => {
							const nextRun = more.slice(0, RUN_LENGTH);
							setServed((s) => new Set([...s, ...nextRun.map((i) => i.key)]));
							setRun(nextRun); setIndex(0); setTally({ right: 0, wrong: 0, written: 0 });
						}}>Continue</Button>
					)}
					<Button type="button" variant="outline" onClick={onExit}>Back</Button>
				</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-4" data-testid="offline-run">
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span>{label} · {index + 1} of {run.length}</span>
				<Button type="button" variant="ghost" size="sm" onClick={onExit}>End</Button>
			</div>
			{current.kind === "quiz"
				? <QuizCard key={current.key + index} item={current} onAnswer={record} onNext={() => setIndex((i) => i + 1)} />
				: <ProblemCard key={current.key + index} item={current} onAnswer={record} onNext={() => setIndex((i) => i + 1)} />}
		</div>
	);
}

function newAttemptId(): string {
	return crypto.randomUUID();
}

function QuizCard({ item, onAnswer, onNext }: { item: QuizPracticeItem; onAnswer: (a: LocalAttempt) => Promise<void>; onNext: () => void }) {
	const options = useMemo(() => shuffleOptions(item.options), [item]);
	const [selected, setSelected] = useState<string[]>([]);
	const [dontKnow, setDontKnow] = useState(false);
	const [confIdx, setConfIdx] = useState(DEFAULT_CONFIDENCE_INDEX);
	const [done, setDone] = useState<{ correct: boolean } | null>(null);
	const toggle = (value: string) => {
		setDontKnow(false);
		setSelected((s) => item.multiSelect ? (s.includes(value) ? s.filter((v) => v !== value) : [...s, value]) : [value]);
	};
	const submit = async () => {
		const correct = !dontKnow && gradeQuizSelection(item, selected);
		await onAnswer({
			id: newAttemptId(), itemKey: item.key, chatId: item.chatId, kind: "quiz", answeredAt: new Date().toISOString(),
			selected: dontKnow ? [] : selected, correct,
			...(dontKnow ? { dontKnow: true } : { confidence: CONFIDENCE_STOPS[confIdx]! }),
		});
		setDone({ correct });
	};
	return (
		<article className="flex flex-col gap-4" data-testid="offline-quiz">
			<div className="text-[15px]"><Markdown>{item.question}</Markdown></div>
			{item.details && <p className="text-sm text-muted-foreground">{item.details}</p>}
			{item.multiSelect && !done && <p className="text-xs text-muted-foreground">Select all that apply.</p>}
			<ul className="flex flex-col gap-2">
				{options.map((o) => {
					const chosen = selected.includes(o.value);
					const isCorrect = item.correctValues.includes(o.value);
					return (
						<li key={o.value}>
							<button
								type="button"
								disabled={done !== null}
								onClick={() => toggle(o.value)}
								aria-pressed={chosen}
								className={cn(
									"flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
									!done && (chosen ? "border-primary bg-accent" : "border-border hover:bg-accent/40"),
									done && isCorrect && "border-success/60",
									done && chosen && !isCorrect && "border-error/60",
									done && !isCorrect && !chosen && "border-border opacity-60",
								)}
							>
								{done && isCorrect && <CheckIcon className="size-4 shrink-0 text-success" aria-label="correct" />}
								{done && chosen && !isCorrect && <XIcon className="size-4 shrink-0 text-error" aria-label="your answer" />}
								<span>{o.label}</span>
							</button>
						</li>
					);
				})}
			</ul>
			{!done ? (
				<>
					<div className="flex items-center gap-3">
						<span className="text-xs text-muted-foreground">Confidence</span>
						<div className="relative h-4 flex-1">
							<div aria-hidden className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border" style={confidenceRailStyle(CONFIDENCE_STOPS[confIdx]!)} />
							<input
								type="range" min={0} max={100} step={1}
								value={CONFIDENCE_STOPS[confIdx]}
								disabled={dontKnow}
								aria-label="Confidence — the probability your selected answer is correct"
								onChange={(e) => {
									const v = Number(e.target.value);
									let best = 0;
									for (let i = 1; i < CONFIDENCE_STOPS.length; i++) if (Math.abs(CONFIDENCE_STOPS[i]! - v) < Math.abs(CONFIDENCE_STOPS[best]! - v)) best = i;
									setConfIdx(best);
								}}
								style={{ color: CONFIDENCE_COLORS[confIdx] }}
								className={cn(
									"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:opacity-40",
									"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
									"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
									"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
									"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
								)}
							/>
						</div>
						<span className="w-9 text-right font-mono text-sm tabular-nums">{dontKnow ? "—" : `${CONFIDENCE_STOPS[confIdx]}%`}</span>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button type="button" disabled={!dontKnow && selected.length === 0} onClick={() => void submit()} data-testid="offline-quiz-submit">Submit</Button>
						<Button type="button" variant={dontKnow ? "secondary" : "outline"} aria-pressed={dontKnow} onClick={() => { setDontKnow((d) => !d); setSelected([]); }}>
							I don&apos;t know
						</Button>
					</div>
				</>
			) : (
				<>
					<p className={cn("text-sm font-medium", done.correct ? "text-success" : "text-error")} data-testid="offline-quiz-result">
						{done.correct ? "Correct" : dontKnow ? "Not answered" : "Incorrect"}
					</p>
					{item.explanation && <div className="text-[15px]"><Markdown>{item.explanation}</Markdown></div>}
					<Button type="button" className="self-start" onClick={onNext} data-testid="offline-next">Next</Button>
				</>
			)}
		</article>
	);
}

function ProblemCard({ item, onAnswer, onNext }: { item: ProblemPracticeItem; onAnswer: (a: LocalAttempt) => Promise<void>; onNext: () => void }) {
	const [answer, setAnswer] = useState("");
	const [saved, setSaved] = useState(false);
	const submit = async (text: string) => {
		await onAnswer({ id: newAttemptId(), itemKey: item.key, chatId: item.chatId, kind: "problem", answeredAt: new Date().toISOString(), answer: text });
		setSaved(true);
	};
	return (
		<article className="flex flex-col gap-4" data-testid="offline-problem">
			<p className="text-xs uppercase tracking-widest text-muted-foreground">Problem</p>
			<div className="text-[15px]"><Markdown>{item.statement}</Markdown></div>
			{!saved ? (
				<>
					<textarea
						value={answer}
						onChange={(e) => setAnswer(e.target.value)}
						placeholder="Write your answer."
						className="min-h-40 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[15px] outline-none focus:border-primary/60"
						data-testid="offline-problem-answer"
					/>
					<div className="flex flex-wrap gap-2">
						<Button type="button" disabled={!answer.trim()} onClick={() => void submit(answer.trim())} data-testid="offline-problem-submit">Submit</Button>
						<Button type="button" variant="outline" onClick={() => void submit("")}>I don&apos;t know</Button>
					</div>
				</>
			) : (
				<>
					<p className="text-sm text-muted-foreground" data-testid="offline-problem-saved">
						Saved. It&apos;s graded when your computer is reachable; the model solution appears with the verdict under Practice → Your written answers.
					</p>
					<Button type="button" className="self-start" onClick={onNext} data-testid="offline-next">Next</Button>
				</>
			)}
		</article>
	);
}
