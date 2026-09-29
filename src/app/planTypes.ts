/**
 * Phase 2 — Planning Engine types (in-memory only; Neo4j stays long-term memory).
 *
 * Flow: Intent(task, confidence >= threshold) → Planner → IPlan →
 * PlanExecutor → ToolRegistry/MCP tools → Results → LLM → Response.
 *
 * Plans are TRANSIENT execution state: never written to Neo4j in Phase 2.
 * Useful outcomes (completed/failed/recurring tasks, discovered preferences)
 * may be persisted later via the existing memory pipeline.
 */

/**
 * Lifecycle of a single step. "skipped" means the step never ran because a
 * dependency did not complete (failed, or was itself skipped) — the plan's
 * internal state now matches the "skipped" IStepResult the executor records,
 * so there is no more failed/skipped mismatch.
 */
export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** Lifecycle of a whole plan. */
export type PlanStatus = "pending" | "running" | "completed" | "failed";

/**
 * What a step IS — so the executor never conflates
 * **planner reasoning** with **agent/LLM reasoning**:
 *
 *  - "tool"     — external capability executed via ToolRegistry (MCP in Phase 3).
 *  - "decision" — planner-side judgement: pick/filter/score. No side effects, no
 *                 external capability. Resolved by the planner layer.
 *  - "action"   — agent-side action: something the agent runtime must carry out
 *                 (draft, compute, act) without an external tool. Resolved by
 *                 the agent layer.
 *  - "response" — final response formulation. Owned by the LLM; the executor
 *                 only records the intent so the LLM knows it must answer.
 */
export type PlanStepKind = "tool" | "decision" | "action" | "response";

export const PLAN_STEP_KINDS: readonly PlanStepKind[] = ["tool", "decision", "action", "response"];

export interface IPlanStep {
    id: string;
    goal: string;

    /** Step nature. Inferred by {@link resolveStepKind} when omitted. */
    kind?: PlanStepKind;

    /** Registered tool name (e.g. "web.search") — required for kind === "tool". */
    tool?: string;
    args?: Record<string, unknown>;

    /** Ids of steps that must complete before this one may run. */
    dependsOn?: string[];

    status: PlanStepStatus;
}

/**
 * Explicit `kind`, or an inference that keeps hand-written/LLM plans working:
 *   tool present                → "tool"
 *   goal asks to respond/report → "response"
 *   otherwise                   → "decision" (planner-side reasoning)
 */
export function resolveStepKind(step: IPlanStep): PlanStepKind {
    if (step.kind && PLAN_STEP_KINDS.includes(step.kind)) return step.kind;
    if (step.tool) return "tool";
    if (/\b(respond|reply|answer|report|confirm|summar(y|ise|ize)|present|tell the user)\b/i.test(step.goal)) {
        return "response";
    }
    return "decision";
}

export interface IPlan {
    id: string;
    /** Phase 2 only plans tasks; kept literal for forward-compat. */
    intent: "task";
    goal: string;
    steps: IPlanStep[];
    createdAt: string;
    status: PlanStatus;
}

/** Minimum intent confidence that triggers planning (else ask/clarify). */
export const TASK_PLAN_THRESHOLD = 0.75;

let planSeq = 0;

/** Create a fresh plan shell (steps filled by the planner / validator). */
export function createPlanShell(goal: string, steps: IPlanStep[] = []): IPlan {
    planSeq += 1;
    return {
        id: `plan-${Date.now()}-${planSeq}`,
        intent: "task",
        goal,
        steps,
        createdAt: new Date().toISOString(),
        status: "pending",
    };
}

/** Reset the in-process sequence (tests only). */
export function __resetPlanSeqForTests(): void {
    planSeq = 0;
}
