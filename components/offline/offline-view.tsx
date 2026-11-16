"use client";

/**
 * The offline view's UI (offline wave A, 2026-11-16): top tabs (Sessions |
 * Notes), each a newest-first list → a read-only reader. Everything comes
 * from the device's IndexedDB copy; when the server is reachable the copy
 * syncs in the background and the lists refresh. Practice joins as a third
 * tab in wave B.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, FileTextIcon, MessagesSquareIcon, RefreshCwIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { MarkdownDisplayOnlyContext } from "@/components/md-blocks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { offlineNotesInOrder, offlineSessionsInOrder, type OfflineCopy, type OfflineNoteDoc, type OfflineSessionDoc } from "@/src/core";
import { loadOfflineCopy, offlineDbAvailable } from "./offline-db";
import { loadOfflineStatusMeta, syncOfflineCopy, useOfflineStatus } from "./offline-sync";

type Tab = "sessions" | "notes";
type Open = { tab: "sessions"; id: string } | { tab: "notes"; id: string } | null;

const EMPTY: OfflineCopy = { sessions: new Map(), notes: new Map() };

function formatWhen(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function OfflineView() {
	const status = useOfflineStatus();
	const [copy, setCopy] = useState<OfflineCopy | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("sessions");
	const [open, setOpen] = useState<Open>(null);

	// The OfflineClient (root layout) syncs while reachable; this page
	// also kicks one so opening it online shows fresh content.
	useEffect(() => { void loadOfflineStatusMeta(); void syncOfflineCopy(); }, []);

	useEffect(() => {
		if (!offlineDbAvailable()) { setLoadError("This browser can't store an offline copy."); return; }
		let cancelled = false;
		loadOfflineCopy()
			.then((c) => { if (!cancelled) { setCopy(c); setLoadError(null); } })
			.catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
		return () => { cancelled = true; };
	}, [status.copyVersion]);

	const current = copy ?? EMPTY;
	const sessions = useMemo(() => offlineSessionsInOrder(current), [current]);
	const notes = useMemo(() => offlineNotesInOrder(current), [current]);
	const openSession = open?.tab === "sessions" ? current.sessions.get(open.id) : undefined;
	const openNote = open?.tab === "notes" ? current.notes.get(open.id) : undefined;

	return (
		<div data-testid="offline-view" className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-10">
			<header className="sticky top-0 z-10 -mx-4 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur">
				<div className="flex items-center justify-between gap-3">
					<h1 className="text-sm font-medium">Offline copy</h1>
					<SyncLine />
				</div>
				<nav role="tablist" aria-label="Offline sections" className="mt-2 flex gap-1">
					{([["sessions", "Sessions", MessagesSquareIcon], ["notes", "Notes", FileTextIcon]] as const).map(([id, label, Icon]) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							data-testid={`offline-tab-${id}`}
							onClick={() => { setTab(id); setOpen(null); }}
							className={cn(
								"-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
								tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							<Icon className="size-4" aria-hidden />{label}
						</button>
					))}
				</nav>
			</header>

			<main className="flex-1 pt-4">
				{loadError ? (
					<p className="text-sm text-muted-foreground">{loadError}</p>
				) : copy === null ? (
					<p className="text-sm text-muted-foreground">Loading offline copy…</p>
				) : openSession ? (
					<Reader title={openSession.title} meta={formatWhen(openSession.updatedAt)} onBack={() => setOpen(null)}>
						{openSession.markdown}
					</Reader>
				) : openNote ? (
					<Reader title={openNote.label} meta={openNote.filePath} onBack={() => setOpen(null)}>
						{openNote.markdown ?? null}
					</Reader>
				) : tab === "sessions" ? (
					<List
						empty="No sessions saved on this device yet. Open the app while connected to your computer to download them."
						items={sessions.map((s: OfflineSessionDoc) => ({
							id: s.id, title: s.title,
							meta: `${s.kind === "practice" ? "Practice · " : ""}${formatWhen(s.updatedAt)}`,
						}))}
						onOpen={(id) => setOpen({ tab: "sessions", id })}
					/>
				) : (
					<List
						empty="No imported notes saved on this device."
						items={notes.map((n: OfflineNoteDoc) => ({
							id: n.id, title: n.label,
							meta: n.markdown === null ? "Unavailable — re-import to read offline" : formatWhen(n.importedAt),
							muted: n.markdown === null,
						}))}
						onOpen={(id) => setOpen({ tab: "notes", id })}
					/>
				)}
			</main>
		</div>
	);
}

function SyncLine() {
	const status = useOfflineStatus();
	const text = status.syncing
		? "Syncing…"
		: status.reachable === false
			? `Offline${status.lastSyncAt ? ` · copy from ${formatWhen(status.lastSyncAt)}` : ""}`
			: status.lastSyncAt
				? `Synced ${formatWhen(status.lastSyncAt)}`
				: "Not synced yet";
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="offline-sync-line">
			<span>{text}</span>
			{status.reachable !== false && (
				<Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Sync now" disabled={status.syncing} onClick={() => void syncOfflineCopy()}>
					<RefreshCwIcon className={cn("size-3.5", status.syncing && "animate-spin")} />
				</Button>
			)}
		</div>
	);
}

function List({ items, empty, onOpen }: { items: { id: string; title: string; meta: string; muted?: boolean }[]; empty: string; onOpen: (id: string) => void }) {
	if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
	return (
		<ul className="divide-y divide-border">
			{items.map((item) => (
				<li key={item.id}>
					<button
						type="button"
						onClick={() => onOpen(item.id)}
						className="flex w-full flex-col items-start gap-0.5 py-3 text-left transition-colors hover:bg-accent/40"
					>
						<span className={cn("text-sm", item.muted && "text-muted-foreground")}>{item.title}</span>
						<span className="text-xs text-muted-foreground">{item.meta}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

function Reader({ title, meta, onBack, children }: { title: string; meta: string; onBack: () => void; children: string | null }) {
	useEffect(() => { window.scrollTo(0, 0); }, [title]);
	return (
		<article data-testid="offline-reader">
			<Button type="button" variant="ghost" size="sm" className="-ml-2 mb-2" onClick={onBack}>
				<ArrowLeftIcon className="size-4" />Back
			</Button>
			<h2 className="font-title text-xl">{title}</h2>
			{meta && <p className="mt-1 text-xs text-muted-foreground">{meta}</p>}
			<div className="mt-4 text-[15px]">
				{children === null ? (
					<p className="text-sm text-muted-foreground">This note was imported before offline snapshots existed. Re-import it while connected to read it here.</p>
				) : (
					<MarkdownDisplayOnlyContext.Provider value={true}>
						<ToolContentResponse>{children}</ToolContentResponse>
					</MarkdownDisplayOnlyContext.Provider>
				)}
			</div>
		</article>
	);
}
