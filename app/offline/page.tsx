import type { Metadata } from "next";
import { OfflineView } from "@/components/offline/offline-view";

/**
 * The offline view (offline wave A, 2026-11-16): reads only the device's
 * IndexedDB copy, so the service worker can serve this page's cached shell
 * when the computer is unreachable. Rendered outside the app shell
 * (AppShell bypasses this path): no sidebar, no live server fetches.
 */
export const metadata: Metadata = { title: "Offline · Learning Harness" };

export default function OfflinePage() {
	return <OfflineView />;
}
