/**
 * Offline-practice sittings waiting on the server (offline wave B): one
 * JSON file per sitting under PATHS.offlinePending. Written atomically;
 * removed once the sitting is appended to its session's history.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { OfflineSittingStore } from "../core/ports.ts";
import type { PendingSitting } from "../core/offline-practice.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const SITTING_ID = /^sit_[A-Za-z0-9_-]{6,64}$/;

function fileOf(id: string): string {
	if (!SITTING_ID.test(id)) throw new Error(`Invalid sitting id: ${id}`);
	return path.join(/* turbopackIgnore: true */ PATHS.offlinePending, `${id}.json`);
}

export const offlineSittingStore: OfflineSittingStore = {
	list() {
		let names: string[];
		try { names = fs.readdirSync(/* turbopackIgnore: true */ PATHS.offlinePending); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const out: PendingSitting[] = [];
		for (const name of names) {
			if (!name.endsWith(".json") || !SITTING_ID.test(name.slice(0, -5))) continue;
			try { out.push(JSON.parse(fs.readFileSync(path.join(/* turbopackIgnore: true */ PATHS.offlinePending, name), "utf8")) as PendingSitting); }
			catch (error) { console.error(`[offline] unreadable sitting ${name}:`, error); }
		}
		return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	},
	put(sitting) {
		fs.mkdirSync(PATHS.offlinePending, { recursive: true });
		writeFileAtomicSync(fileOf(sitting.id), JSON.stringify(sitting, null, "\t"));
	},
	remove(id) {
		const file = fileOf(id);
		fs.rmSync(file, { force: true });
		removeLeftoverTemps(file);
	},
};
