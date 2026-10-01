/**
 * Phase 4D — ExecutionResultProcessor: canonical execution → memory candidates.
 *
 * Responsibility (frozen):
 *   IPlanExecutionResult → MemoryCandidate[]
 *
 * It answers ONE question: which execution results are eligible to become
 * memory candidates? It does NOT extract facts, does NOT detect conflicts, and
 * does NOT write Neo4j. This module must stay free of:
 *   - Neo4j / MemoryStore imports
 *   - OpenAI / network calls
 *   - any graph mutation
 *
 * That preserves the Phase 3.11 boundary: MCP/tool results reach the graph
 * only through the existing extraction → conflict → feedback pipeline.
 */
import type { IPlanExecutionResult, IStepResult } from "../planExecutor.js";
import type {
    ICandidateEligibility,
    IExecutionResultProcessor,
    IMemoryCandidate,
} from "./executionResultTypes.js";

const DEFAULT_ELIGIBILITY: Required<ICandidateEligibility> = {
    includeTools: true,
    includeActions: true,
    includeDecisions: true,
    // Response is generated language, not necessarily new information.
    includeResponses: false,
};

export class ExecutionResultProcessor implements IExecutionResultProcessor {
    private readonly eligibility: Required<ICandidateEligibility>;

    constructor(eligibility: ICandidateEligibility = {}) {
        this.eligibility = { ...DEFAULT_ELIGIBILITY, ...eligibility };
    }

    /** Deterministic eligibility rules over the canonical execution record. */
    public process(result: IPlanExecutionResult): IMemoryCandidate[] {
        if (!result || !Array.isArray(result.steps)) return [];
        return result.steps
            .filter(step => this.isEligible(step))
            .map(step => this.toCandidate(result, step));
    }

    /**
     * Eligibility (4D.6):
     *   completed + output exists + kind allowed → candidate
     *   failed  → never (an error is not knowledge)
     *   skipped → never (the step never ran; Phase 3.5 semantics)
     */
    private isEligible(step: IStepResult): boolean {
        if (step.status !== "completed") return false;
        if (step.output === undefined || step.output === null) return false;
        switch (step.kind) {
            case "tool": return this.eligibility.includeTools;
            case "action": return this.eligibility.includeActions;
            case "decision": return this.eligibility.includeDecisions;
            case "response": return this.eligibility.includeResponses;
            default: return false;
        }
    }

    private toCandidate(result: IPlanExecutionResult, step: IStepResult): IMemoryCandidate {
        return {
            source: "execution",
            planId: result.planId,
            stepId: step.stepId,
            kind: step.kind,
            ...(step.tool ? { tool: step.tool } : {}),
            ...(step.action ? { action: step.action } : {}),
            goal: step.goal,
            // Structured output only — the formatted [Execution] string is
            // presentation and must never become memory.
            content: step.output,
        };
    }
}

/** Convenience factory matching the codebase's create* pattern. */
export function createExecutionResultProcessor(
    eligibility: ICandidateEligibility = {},
): ExecutionResultProcessor {
    return new ExecutionResultProcessor(eligibility);
}