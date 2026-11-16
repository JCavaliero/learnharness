/**
 * Imported-notes text snapshots (offline wave A, 2026-11-16): one file per
 * notes source under config.SOURCE_TEXT_DIR. Written at import so the
 * offline copy can show notes even when the original file has moved.
 * Presentation only — extraction never reads these.
 */
import fs from "node:fs";
import path from "node:path";
import { SOURCE_TEXT_DIR } from "../../config.ts";
import type { SourceTextStore } from "../core/ports.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const SOURCE_ID = /^src_[0-9a-f]{12}$/;

function fileOf(sourceId: string): string | null {
	return SOURCE_ID.test(sourceId) ? path.join(/* turbopackIgnore: true */ SOURCE_TEXT_DIR, `${sourceId}.md`) : null;
}

export const sourceTextStore: SourceTextStore = {
	write(sourceId, text) {
		const file = fileOf(sourceId);
		if (!file) throw new Error(`Invalid notes source id: ${sourceId}`);
		fs.mkdirSync(SOURCE_TEXT_DIR, { recursive: true });
		writeFileAtomicSync(file, text);
	},
	read(sourceId) {
		const file = fileOf(sourceId);
		if (!file) return null;
		try { return fs.readFileSync(file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	},
	remove(sourceIds) {
		for (const id of sourceIds) {
			const file = fileOf(id);
			if (!file) continue;
			fs.rmSync(file, { force: true });
			removeLeftoverTemps(file);
		}
	},
};
