/**
 * Phase 4A (4.1) — Action Engine types: internal agent capabilities.
 *
 * Responsibility split, extending the Phase 2 kind model:
 *   kind === "tool"     → ToolRegistry          (EXTERNAL capability via MCP)
 *   kind === "action"   → ActionRegistry        (INTERNAL agent capability)
 *   kind === "decision" → Planner layer         (planner-side judgement)
 *   kind === "response" → LLM                   (response formulation)
 *
 * An Action needs no MCP tool, no network, no side effects outside the
 * agent runtime: draft text, compute, format, summarize, pick, compose.
 * Tool steps go through the permission policy; action steps never touch it —
 * there is no external capability to gate.
 */

import type { IPlanStep } from "../planTypes.js";

/** What the action should do — resolved by name at execution time. */
export interface IActionContext {
    /** The plan step being executed (goal + explicit routing fields only). */
    stepId: string;
    goal: string;
    args: Record<string, unknown>;
    /** Outputs of already-completed steps, keyed by step id. */
    priorOutputs: Record<string, unknown>;
}

export type ActionExecutorFn = (context: IActionContext) => Promise<unknown> | unknown;

export interface IActionDefinition {
    name: string;
    description: string;
    execute: ActionExecutorFn;
}

/** Build an action context from a plan step + accumulated prior outputs. */
export function actionContextFromStep(
    step: IPlanStep,
    priorOutputs: Record<string, unknown>,
): IActionContext {
    return {
        stepId: step.id,
        goal: step.goal,
        args: step.args ?? {},
        priorOutputs,
    };
}
