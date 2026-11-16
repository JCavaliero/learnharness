import { createHash } from "node:crypto";

/** The notes source id the extraction pipeline mints for a file path
 *  (extraction.importNotes and sourceDirectory.registerImport compute the
 *  same hash inline). */
export function notesSourceId(filePath: string): string {
	return `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}
