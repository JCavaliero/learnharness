"use client";
/**
 * Offline copy (offline wave A, 2026-11-16): this device's sync status, a
 * manual sync, and "Clear offline data on this device". The status is
 * shown only here in the normal app (owner); the offline view shows its
 * own line.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { clearOfflineCopy, listLocalAttempts, offlineDbAvailable } from "@/components/offline/offline-db";
import { loadOfflineStatusMeta, noteOfflineCopyCleared, syncOfflineCopy, useOfflineStatus } from "@/components/offline/offline-sync";
import { SettingsRow } from "./controls.tsx";

function when(iso: string | null): string {
	if (!iso) return "Never";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "Never" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function OfflineSection() {
	const status = useOfflineStatus();
	const [clearing, setClearing] = useState(false);
	const [clearError, setClearError] = useState<string | null>(null);
	useEffect(() => { void loadOfflineStatusMeta(); }, []);

	if (!offlineDbAvailable()) {
		return <p className="text-xs text-muted-foreground">This browser can&apos;t store an offline copy.</p>;
	}
	const hint = status.syncing
		? "Syncing…"
		: status.reachable === false
			? "Can't reach the computer right now."
			: status.error ?? `Last synced: ${when(status.lastSyncAt)}`;
	return (
		<>
			<SettingsRow label="Offline copy" hint={hint} testid="offline-sync-row">
				<Button type="button" variant="outline" size="sm" disabled={status.syncing} onClick={() => void syncOfflineCopy()}>
					Sync now
				</Button>
			</SettingsRow>
			<SettingsRow
				label="Clear offline data on this device"
				hint={clearError ?? "Removes the saved sessions, notes and practice answers from this device. Your computer keeps everything it has received."}
				testid="offline-clear-row"
			>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={clearing}
					onClick={async () => {
						const unsent = (await listLocalAttempts().catch(() => [])).filter((a) => !a.uploaded).length;
						const warning = unsent > 0
							? `${unsent} offline ${unsent === 1 ? "answer hasn't" : "answers haven't"} been uploaded yet and will be lost. Clear the offline copy on this device anyway?`
							: "Clear the offline copy on this device?";
						if (!window.confirm(warning)) return;
						setClearing(true); setClearError(null);
						try { await clearOfflineCopy(); noteOfflineCopyCleared(); }
						catch (err) { setClearError(err instanceof Error ? err.message : String(err)); }
						finally { setClearing(false); }
					}}
				>
					Clear
				</Button>
			</SettingsRow>
		</>
	);
}
