/**
 * The offline grader (offline wave B, owner 2026-11-16): one cheap-tier
 * submit agent per free-form answer written on the tablet. It sees the
 * problem statement, the model solution committed at pose time, and the
 * learner's answer, and returns the practice-conclude fields (no hint
 * rung — there were no hints offline). The system prompt is the
 * owner-approved text.
 */
import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import type { GraderVerdict } from "../../core/offline-practice.ts";

export const OFFLINE_GRADER_PROMPT = `You grade one answer a learner wrote offline to a practice problem — no hints, no conversation, one attempt.

You receive: the problem statement, the model solution that was committed when the problem was posed, and the learner's answer. Judge the answer against the model solution. A different valid route to the correct result counts.

outcome:
- solved: the answer reaches the correct result with sound reasoning.
- movedOn: an attempt that is wrong or incomplete.
- surrendered: blank, or no real attempt ("I don't know").

verdict: plain language to the learner — what was credited and where it broke. On a miss, localize the break; don't restate the model solution (it is shown next to your verdict).

missClass (null when solved): cue (nothing came), discrimination (wrong candidate won), execution (right proposition, wrong run), careless, or structural (the retrieved proposition is itself wrong — a misconception).

retest: true when this material should come back soon in a fresh surface.

Call submit_grade exactly once.`;

const gradeSchema = Type.Object({
	outcome: Type.Union([Type.Literal("solved"), Type.Literal("movedOn"), Type.Literal("surrendered")], {
		description: "REQUIRED — solved, movedOn, or surrendered (bare words).",
	}),
	verdict: Type.String({ description: "REQUIRED — the plain-language verdict to the learner." }),
	missClass: Type.Union(
		[Type.Literal("cue"), Type.Literal("discrimination"), Type.Literal("execution"), Type.Literal("careless"), Type.Literal("structural"), Type.Null()],
		{ description: "REQUIRED — cue, discrimination, execution, careless, structural, or null when solved." },
	),
	retest: Type.Boolean({ description: "REQUIRED — true when this should come back soon in a fresh surface." }),
});

export interface OfflineGradeInput {
	statement: string;
	modelSolution: string;
	answer: string;
}

export function offlineGraderPrompt(input: OfflineGradeInput): string {
	return [
		"## Problem statement", "", input.statement.trim(), "",
		"## Model solution (committed when the problem was posed)", "", input.modelSolution.trim(), "",
		"## The learner's answer", "", input.answer.trim() || "(blank)",
	].join("\n");
}

export async function gradeOfflineAnswer(opts: {
	input: OfflineGradeInput;
	engine: PiEngine | undefined;
	chatId: string;
	signal?: AbortSignal;
	onStep: (usage: Usage, model: string) => void;
}): Promise<GraderVerdict> {
	return runSubmitAgent<GraderVerdict>({
		role: "offlineGrader",
		chatId: opts.chatId,
		toolName: "submit_grade",
		toolDescription: "Submit the grade for the learner's offline answer.",
		parameters: gradeSchema,
		fill: (raw: GraderVerdict) => ({
			outcome: raw.outcome,
			verdict: raw.verdict.trim(),
			missClass: raw.outcome === "solved" ? null : raw.missClass,
			retest: raw.retest,
		}),
		validate: (v) => (v.verdict ? null : "verdict must not be empty"),
		systemPrompt: OFFLINE_GRADER_PROMPT,
		prompt: offlineGraderPrompt(opts.input),
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep(usage, model),
		neverSubmitted: "the offline grader never submitted a grade",
	});
}
