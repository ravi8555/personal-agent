/**
 * Dynamic Context builder — the single seam where the two engines meet:
 *
 *   Memory Engine    → "What do I know?"   → [Relevant memory]
 *   Planning Engine  → "What should I do?" → [Current task] + [Execution]
 *                                              ↓
 *                                             LLM
 *
 * The Memory Engine keeps ownership of retrieval/context formatting
 * (`RunningContext.text` is embedded verbatim); this module only *labels*
 * sections so the LLM knows what is remembered vs. what was actually done.
 * That is what stops the model from pretending it performed the task.
 */

import type { IIntentResult } from "./intentEngine.js";
import type { IPlan } from "./planTypes.js";
import { summarizeExecution } from "./planExecutor.js";
import type { IPlanExecutionResult } from "./planExecutor.js";

export interface IDynamicContextInput {
    /** Memory Engine output (RunningContext) — embedded unchanged. */
    runningContext?: string | null;
    /** Phase 1 classification of the current turn. */
    intent?: IIntentResult | null;
    /** Phase 2 plan (present once the planner accepted the task). */
    plan?: IPlan | null;
    /** Phase 2 execution result (present once the executor ran the plan). */
    execution?: IPlanExecutionResult | null;
    /**
     * Planning could not complete (below threshold / invalid plan).
     * Rendered under [Current task] so the LLM asks instead of guessing.
     */
    planningNote?: string | null;
}

function section(title: string, lines: string[]): string {
    return [`[${title}]`, ...lines.map(l => `- ${l}`)].join("\n");
}

/**
 * Assembles the labelled dynamic context. Returns `null` when there is nothing
 * to add, so the caller falls back to bare instructions.
 */
export function buildDynamicContext(input: IDynamicContextInput): string | null {
    const blocks: string[] = [];

    // 1. Memory Engine → what the agent knows about the user.
    const memory = typeof input.runningContext === "string" ? input.runningContext.trim() : "";
    if (memory) blocks.push(section("Relevant memory", [memory]));

    // 2. Planning Engine → what the current task is.
    const taskLines: string[] = [];
    if (input.plan) {
        taskLines.push(`Goal: ${input.plan.goal}`);
        taskLines.push(`Plan: ${input.plan.id} (${input.plan.steps.length} step(s), now ${input.plan.status})`);
    } else if (input.planningNote && input.intent?.type === "task") {
        taskLines.push(input.planningNote);
    }
    if (taskLines.length > 0) blocks.push(section("Current task", taskLines));

    // 3. Planning Engine → what actually happened (never invented by the LLM).
    if (input.execution) {
        const lines = summarizeExecution(input.execution);
        lines.push(`Plan outcome: ${input.execution.status}`);
        blocks.push(section("Execution", lines));
    }

    // 4. Explicit instruction so execution results are used, not hallucinated.
    if (input.execution) {
        blocks.push(section("Instruction", [
            "Use the execution results above to formulate the final response.",
            "Only describe actions that appear under [Execution]; never invent tool output.",
        ]));
    }

    return blocks.length > 0 ? blocks.join("\n\n") : null;
}
