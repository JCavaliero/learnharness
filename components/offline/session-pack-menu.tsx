"use client";

/**
 * The session top bar's "…" menu (offline wave C, owner 2026-11-16): its
 * one action makes an offline practice pack for this session. The pack is
 * written in the background — progress shows in the activity dock, and
 * the pack reaches the tablet with the next sync.
 */
import { useRef, useState } from "react";
import { EllipsisIcon, PackageIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";

export function SessionPackMenu({ chatId }: { chatId: string }) {
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const make = async () => {
		setOpen(false);
		setNote(null);
		try {
			const res = await fetch("/api/offline/packs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId }),
			});
			if (!res.ok) setNote(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Could not start (${res.status})`);
		} catch {
			setNote("Could not reach the server");
		}
	};
	return (
		<>
			<button
				ref={anchor}
				type="button"
				data-testid="session-actions"
				aria-label="Session actions"
				aria-expanded={open}
				title={note ?? "Session actions"}
				onClick={() => setOpen((o) => !o)}
				className="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<EllipsisIcon className="size-4" />
			</button>
			{note && <span role="status" className="lh-no-drag shrink-0 text-xs text-error">{note}</span>}
			{open && (
				<MenuShell
					anchorRef={anchor}
					testid="session-actions-menu"
					preferredSide="down"
					onClose={() => { setOpen(false); return "closed"; }}
					menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<button
						type="button"
						data-testid="make-offline-pack"
						onClick={() => void make()}
						className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
					>
						<PackageIcon className="size-3.5" />
						Make offline pack
					</button>
				</MenuShell>
			)}
		</>
	);
}
