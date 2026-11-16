"use client";

/**
 * The always-mounted offline half of the app (offline wave A, 2026-11-16):
 *
 * - registers the service worker in production builds (and removes any
 *   registration in dev, where a cached shell would fight hot reload);
 *   the desktop app is skipped — its server is always local;
 * - keeps the device's offline copy current: syncs on load, on reconnect,
 *   and whenever the server announces a change (debounced);
 * - while the server is unreachable, retries every 15 s and shows the
 *   "Offline — open offline view" banner (owner: banner + link, no
 *   automatic switch).
 */
import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { WifiOffIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { loadOfflineStatusMeta, markUnreachable, syncOfflineCopy, useOfflineStatus } from "./offline-sync";

export const OFFLINE_PATH = "/offline";
const SYNC_DEBOUNCE_MS = 2_000;
const RETRY_MS = 15_000;

function isDesktopShell(): boolean {
	return typeof window !== "undefined" && "lh" in window && window.lh !== undefined;
}

function useServiceWorker(): void {
	useEffect(() => {
		if (!("serviceWorker" in navigator) || isDesktopShell()) return;
		if (process.env.NODE_ENV !== "production") {
			void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister())).catch(() => {});
			return;
		}
		let cancelled = false;
		void navigator.serviceWorker.register("/sw.js").then(async () => {
			const ready = await navigator.serviceWorker.ready;
			// Each online load re-caches the offline shell, so a new build's
			// assets replace the old ones without waiting for a SW update.
			if (!cancelled) ready.active?.postMessage({ type: "refresh-shell" });
		}).catch(() => { /* unsupported context (plain-http LAN): no offline shell */ });
		return () => { cancelled = true; };
	}, []);
}

export function OfflineClient() {
	useServiceWorker();
	const status = useOfflineStatus();
	const pathname = usePathname();
	const timer = useRef<number | undefined>(undefined);

	const schedule = useCallback(() => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => void syncOfflineCopy(), SYNC_DEBOUNCE_MS);
	}, []);

	useEffect(() => {
		void loadOfflineStatusMeta();
		void syncOfflineCopy();
		const online = () => void syncOfflineCopy();
		window.addEventListener("online", online);
		window.addEventListener("offline", markUnreachable);
		return () => {
			window.clearTimeout(timer.current);
			window.removeEventListener("online", online);
			window.removeEventListener("offline", markUnreachable);
		};
	}, []);

	useServerResync(schedule);
	useServerEvent("chats-changed", schedule);
	useServerEvent("sources-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("record-changed", schedule);

	useEffect(() => {
		if (status.reachable !== false) return;
		const id = window.setInterval(() => void syncOfflineCopy(), RETRY_MS);
		return () => window.clearInterval(id);
	}, [status.reachable]);

	if (status.reachable !== false || pathname === OFFLINE_PATH) return null;
	return (
		<div
			role="status"
			data-testid="offline-banner"
			className="fixed inset-x-0 top-2 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
		>
			<WifiOffIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<span>Offline — can&apos;t reach your computer.</span>
			{/* A full navigation, so the service worker can serve the shell. */}
			<a href={OFFLINE_PATH} className="font-medium underline underline-offset-2">Open offline view</a>
		</div>
	);
}
