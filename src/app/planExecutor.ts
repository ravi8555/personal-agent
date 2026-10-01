/**
 * Phase 2 — PlanExecutor: runs an approved IPlan in dependency order.
 *
 * Responsibility split (locked in Phase 2):
 *   Planner        → "what steps are required?"
 *   planValidator  → "is this plan structurally sound?"
 *   PlanExecutor   → "execute the approved steps in the correct order."
 *   ToolRegistry   → "how do I perform those steps?" (MCP-ready in Phase 3)
 *
 * The executor is deliberately independent of the Agent and of Neo4j:
 * plans are TRANSIENT execution state held in memory.
 */

import type { IPlan, IPlanStep, PlanStepKind } from "./planTypes.js";
import { resolveStepKind } from "./planTypes.js";
import type { ToolRegistry } from "./toolRegistry.js";
import type { IToolPolicy } from "./toolPolicy.js";
import { actionContextFromStep } from "./action/actionTypes.js";
import type { ActionRegistry } from "./action/actionRegistry.js";

/**
 * Phase 4D — canonical step result.
 *
 * One result model for ALL step kinds (no IToolExecutionResult /
 * IActionExecutionResult / IDecisionExecutionResult): the unified envelope is
 * the whole point. Provenance fields carry exactly what the downstream
 * processor needs to know: what was requested, what capability performed it,
 * and what came back.
 *
 * NOTE: `args` is INTERNAL provenance — the ExecutionResultProcessor must not
 * turn tool/action arguments into memory automatically (gmail.send,
 * calendar.delete, web.search query text are not facts).
 */
export interface IStepResult {
    stepId: string;
    goal: string;
    status: "completed" | "failed" | "skipped";
    /** Step nature — keeps planner reasoning distinct from agent/LLM reasoning. */
    kind: PlanStepKind;
    tool?: string;
    /** Phase 4D: action name for kind === "action" steps (canonical result). */
    action?: string;
    /** 4D.2: the arguments the step was executed with (internal provenance only). */
    args?: Record<string, unknown>;
    output?: unknown;
    error?: string;
}

export interface IPlanExecutionResult {
    planId: string;
    goal: string;
    status: "completed" | "failed";
    steps: IStepResult[];
    startedAt: string;
    finishedAt: string;
}

export interface IExecutorHooks {
    /**
     * kind === "decision": PLANNER-side judgement (pick/filter/score).
     * Defaults to a deterministic acknowledgement of the decision.
     */
    runDecisionStep?: (step: IPlanStep, plan: IPlan) => Promise<unknown>;
    /**
     * kind === "action": AGENT-side action, no external tool.
     * Defaults to a deterministic acknowledgement of the action.
     */
    runActionStep?: (step: IPlanStep, plan: IPlan) => Promise<unknown>;
    /**
     * kind === "response": final formulation is OWNED BY THE LLM. The executor
     * only records that the plan is ready to answer; it never generates prose.
     */
    runResponseStep?: (step: IPlanStep, plan: IPlan) => Promise<unknown>;
    /**
     * Phase 3 (3.9): permission policy consulted BEFORE any tool call —
     * LLM → Planner → Validator → Policy → Executor → Registry → MCP.
     * A non-allow verdict fails the step with its reason; the LLM never
     * reaches MCP directly (3.10).
     */
    policy?: IToolPolicy;
    /** Called as each step changes status (progress/telemetry). */
    onStep?: (result: IStepResult) => void;
    /**
     * Phase 4A (4.1): registry of INTERNAL agent actions. When an action
     * step names a registered action, the executor calls it instead of the
     * legacy acknowledgement — no ToolRegistry, no permission policy.
     */
    actions?: ActionRegistry;
    /** Max steps to run (safety valve against pathological plans). */
    maxSteps?: number;
}

export class PlanExecutor {
    private readonly registry: ToolRegistry;
    private actions: ActionRegistry | undefined;
    private readonly hooks: IExecutorHooks;

    constructor(registry: ToolRegistry, hooks: IExecutorHooks = {}) {
        this.registry = registry;
        this.hooks = hooks;
        this.actions = hooks.actions;
    }

    /** Attach the internal action engine (Phase 4A 4.1). Chainable. */
    public withActions(actions: ActionRegistry): this {
        this.actions = actions;
        return this;
    }

    /**
     * Executes every step whose dependencies have completed, in topological
     * order. A failed step marks all transitive dependents `skipped`; the
     * plan itself ends `failed` (steps stay inspectable for reporting).
     */
    public async execute(plan: IPlan): Promise<IPlanExecutionResult> {
        const startedAt = new Date().toISOString();
        plan.status = "running";
        for (const step of plan.steps) step.status = "pending";

        const stepResults: IStepResult[] = [];
        const byId = new Map(plan.steps.map(s => [s.id, s] as const));
        const maxSteps = this.hooks.maxSteps ?? plan.steps.length + 1;

        let executed = 0;
        let progressed = true;

        while (progressed && executed < maxSteps) {
            progressed = false;

            for (const step of plan.steps) {
                if (step.status !== "pending") continue;

                const deps = step.dependsOn ?? [];
                const depStates = deps.map(id => byId.get(id)?.status);

                // Any dependency that did not complete (failed, or skipped
                // because ITS dependencies failed) → this step never runs.
                // Mark it "skipped" so the plan state matches the recorded
                // IStepResult; skipped dependents propagate the skip further.
                if (depStates.some(s => s === "failed" || s === "skipped")) {
                    step.status = "skipped";
                    this.record(stepResults, {
                        stepId: step.id,
                        goal: step.goal,
                        kind: resolveStepKind(step),
                        status: "skipped",
                        error: `skipped: dependency not completed (${deps.join(", ")})`,
                        ...(step.tool ? { tool: step.tool } : {}),
                    });
                    progressed = true;
                    continue;
                }
                if (depStates.some(s => s !== "completed")) continue; // still waiting

                // Ready to run.
                step.status = "running";
                progressed = true;
                executed++;

                const kind = resolveStepKind(step);
                try {
                    let output: unknown;
                    if (kind === "tool") {
                        if (!step.tool) throw new Error("tool step without a tool name");
                        // Phase 3: permission gate between the plan and any
                        // tool/MCP call. "confirm"/"deny" fail the step with
                        // an explicit reason — dependents are then skipped.
                        if (this.hooks.policy) {
                            const verdict = await this.hooks.policy.canExecute(step.tool, step.args ?? {});
                            if (verdict.decision !== "allow") {
                                throw new Error(`tool policy ${verdict.decision}: ${verdict.reason}`);
                            }
                        }
                        output = await this.registry.execute(step.tool, step.args ?? {});
                    } else if (kind === "decision") {
                        output = this.hooks.runDecisionStep
                            ? await this.hooks.runDecisionStep(step, plan)
                            : { decisionStep: true, decided: step.goal };
                    } else if (kind === "action") {
                        // Phase 4A (4.1): an action step calls an INTERNAL agent
                        // capability by name — never the ToolRegistry, never the
                        // permission policy (there is no external capability to
                        // gate). Legacy hook still wins when provided.
                        if (this.hooks.runActionStep) {
                            output = await this.hooks.runActionStep(step, plan);
                        } else if (step.action && this.actions) {
                            output = await this.actions.execute(
                                step.action,
                                actionContextFromStep(step, this.priorOutputs(stepResults)),
                            );
                        } else {
                            output = { actionStep: true, action: step.action ?? step.goal };
                        }
                    } else {
                        // type === "response": the LLM owns the prose. The executor
                        // only records that the answer must now be formulated.
                        output = this.hooks.runResponseStep
                            ? await this.hooks.runResponseStep(step, plan)
                            : { responseStep: true, awaitingLlm: true, about: step.goal };
                    }
                    step.status = "completed";
                    this.record(stepResults, {
                        stepId: step.id,
                        goal: step.goal,
                        kind,
                        status: "completed",
                        output,
                        ...(step.tool ? { tool: step.tool } : {}),
                        ...(step.action ? { action: step.action } : {}),
                        ...(step.args ? { args: step.args } : {}),
                    });
                } catch (error) {
                    step.status = "failed";
                    this.record(stepResults, {
                        stepId: step.id,
                        goal: step.goal,
                        kind,
                        status: "failed",
                        error: error instanceof Error ? error.message : String(error),
                        ...(step.tool ? { tool: step.tool } : {}),
                        ...(step.action ? { action: step.action } : {}),
                        ...(step.args ? { args: step.args } : {}),
                    });
                }
            }
        }

        const anyFailed = stepResults.some(r => r.status !== "completed");
        plan.status = anyFailed ? "failed" : "completed";

        return {
            planId: plan.id,
            goal: plan.goal,
            status: plan.status === "completed" ? "completed" : "failed",
            steps: stepResults,
            startedAt,
            finishedAt: new Date().toISOString(),
        };
    }

    private record(sink: IStepResult[], result: IStepResult): void {
        sink.push(result);
        this.hooks.onStep?.(result);
    }

    /** Outputs of completed steps, keyed by step id — action-step context. */
    private priorOutputs(stepResults: IStepResult[]): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const result of stepResults) {
            if (result.status === "completed" && result.output !== undefined) {
                // 4C isolation contract: give every step a DEEP CLONE so a
                // later action mutating its context view can never corrupt
                // the canonical step result or an earlier step's outputs.
                out[result.stepId] = cloneValue(result.output);
            }
        }
        return out;
    }
}

/** Deep-clone execution output; fall back to the reference if uncloneable. */
function cloneValue(value: unknown): unknown {
    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

/** Compact, LLM-friendly rendering of execution results (kind-tagged). */
export function formatPlanResult(result: IPlanExecutionResult): string {
    const lines = [`Plan ${result.planId} (${result.status}) — goal: ${result.goal}`];
    for (const s of result.steps) {
        const detail = s.status === "completed"
            ? ` -> ${typeof s.output === "string" ? s.output : JSON.stringify(s.output)}`
            : ` (${s.error ?? "no detail"})`;
        lines.push(`- [${s.kind}/${s.status}] ${s.stepId}: ${s.goal}${detail}`);
    }
    return lines.join("\n");
}

/**
 * Human/LLM-readable bullet list of what actually happened, for the
 * `[Execution]` section of the dynamic context.
 */
export function summarizeExecution(result: IPlanExecutionResult): string[] {
    return result.steps.map(s => {
        const label = s.tool
            ? `${s.kind} "${s.tool}"`
            : s.action
                ? `${s.kind} "${s.action}"`
                : s.kind;
        if (s.status === "completed") {
            const out = typeof s.output === "string" ? s.output : JSON.stringify(s.output);
            return `${s.goal} — done (${label})${out ? `: ${out}` : ""}`;
        }
        return `${s.goal} — ${s.status} (${label})${s.error ? `: ${s.error}` : ""}`;
    });
}
