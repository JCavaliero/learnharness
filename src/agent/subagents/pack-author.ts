/**
 * The pack author (offline wave C, owner 2026-11-16): one strong-tier
 * submit agent writes an offline practice pack for one session. The system
 * prompt is the owner-approved text; the model decides the size (4–20) and
 * the quiz/problem mix. Submits are checked against the live quiz
 * authoring contract and the listed proposition ids — a bad submit goes
 * back to the model to fix (runSubmitAgent's retry loop).
 */
import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { PACK_MAX_ITEMS, PACK_MIN_ITEMS, packDraftProblems, type PackDraftItem } from "../../core/offline-packs.ts";
import { parseOptionsIfString } from "../../core/question-core.ts";

export const PACK_AUTHOR_PROMPT = `You write an offline practice pack for one learner from one session's material. The learner answers it later with no connection: quizzes are graded instantly against your answer key and then show your explanation; free-form problems are graded later against your model solution.

You receive the session transcript and the propositions it covers (ids + statements), plus every item earlier packs and the session already asked.

Decide the size (4–20 items) and the mix from the material: multiple-choice quizzes for crisp recall and discrimination, free-form problems for derivations, explanations and composition.

Every item:
- self-contained, answerable from the material alone; never announces what it tests;
- a fresh surface — never a repeat of an earlier question;
- tagged with target proposition ids when it exercises a listed proposition.
Quizzes: 2+ options as bare claims (no reasoning in options), stable values, correctAnswer by value, an explanation that reinforces why. No "I don't know" option.
Problems: statement in markdown + LaTeX; a complete modelSolution, moves in order.

Call submit_pack exactly once.`;

const target = Type.Optional(Type.Array(Type.String(), { description: "Listed proposition ids this item exercises; omit when none." }));

const quizItem = Type.Object({
	kind: Type.Literal("quiz"),
	question: Type.String({ description: "The question (markdown + LaTeX)." }),
	options: Type.Array(Type.Object({
		label: Type.String({ description: "A bare claim — no reasoning." }),
		value: Type.Optional(Type.String({ description: "Stable value; defaults to the label." })),
	}), { minItems: 2, description: "2+ options as a JSON array (never a string)." }),
	multiSelect: Type.Optional(Type.Boolean({ description: "true when more than one option is correct." })),
	explanation: Type.String({ description: "Shown after answering: why the correct answer is correct." }),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], { description: "The correct option value(s)." }),
	target,
});

const problemItem = Type.Object({
	kind: Type.Literal("problem"),
	statement: Type.String({ description: "The problem (markdown + LaTeX), self-contained." }),
	modelSolution: Type.String({ description: "The complete solution, moves in order." }),
	mode: Type.Optional(Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")])),
	target,
});

const packSchema = Type.Object({
	items: Type.Array(Type.Union([quizItem, problemItem]), {
		minItems: PACK_MIN_ITEMS,
		maxItems: PACK_MAX_ITEMS,
		description: `The pack: ${PACK_MIN_ITEMS}–${PACK_MAX_ITEMS} items, quizzes and problems mixed as the material calls for.`,
	}),
});

export interface PackMaterial {
	/** The session transcript (reading markdown) — may be empty for a
	 *  pack session made from graph picks. */
	transcript: string;
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
	/** Questions/statements already asked (session + earlier packs). */
	asked: string[];
}

export function packAuthorPrompt(m: PackMaterial): string {
	const lines = ["## Propositions", ""];
	if (m.propositions.length === 0) lines.push("(none listed — omit target on every item)");
	for (const p of m.propositions) lines.push(`- [${p.id}] ${p.name}: ${p.statement}`);
	if (m.chains.length > 0) lines.push("", "Reasoning chains among them (premises → conclusion):", ...m.chains.map((c) => `- ${c}`));
	lines.push("", "## Already asked (do not repeat)", "");
	if (m.asked.length === 0) lines.push("(nothing yet)");
	for (const a of m.asked) lines.push(`- ${a.replace(/\s+/g, " ").trim()}`);
	lines.push("", "## Session transcript", "", m.transcript.trim() || "(no transcript — work from the propositions above)");
	return lines.join("\n");
}

export async function writeOfflinePack(opts: {
	material: PackMaterial;
	engine: PiEngine | undefined;
	chatId: string;
	signal?: AbortSignal;
	onStep: (usage: Usage, model: string) => void;
}): Promise<PackDraftItem[]> {
	const known = new Set(opts.material.propositions.map((p) => p.id));
	const result = await runSubmitAgent<{ items: PackDraftItem[] }>({
		role: "packAuthor",
		chatId: opts.chatId,
		toolName: "submit_pack",
		toolDescription: "Submit the offline practice pack.",
		parameters: packSchema,
		// Weak-wire heal: options sometimes arrive as a JSON string.
		fill: (raw: { items: PackDraftItem[] }) => ({
			items: raw.items.map((item) => (item.kind === "quiz"
				? { ...item, options: parseOptionsIfString(item.options) as typeof item.options }
				: item)),
		}),
		validate: (v) => {
			const problems = packDraftProblems(v.items, known);
			return problems.length > 0 ? problems.join("\n") : null;
		},
		systemPrompt: PACK_AUTHOR_PROMPT,
		prompt: packAuthorPrompt(opts.material),
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep(usage, model),
		neverSubmitted: "the pack author never submitted a pack",
		maxTurns: 6,
	});
	return result.items;
}
