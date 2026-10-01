/**
 * Phase 4D — execution → memory-candidate boundary types.
 *
 * THE key distinction:
 *
 *   IStepResult      = "What happened during execution?"   (execution truth)
 *   IMemoryCandidate = "What information from that execution might be worth
 *                       remembering?"                       (candidate interpretation)
 *
 * A candidate is NOT a fact and is NOT persisted. It is the hand-off point to
 * the existing Memory Extraction → Conflict Detection → Feedback → Neo4j
 * pipeline (Phase 4E+). Nothing in this module may touch Neo4j.
 */
import type { IPlanExecutionResult } from "../planExecutor.js";
import type { PlanStepKind } from "../planTypes.js";

/**
 * A single piece of execution output that MAY be worth remembering.
 * Deliberately named "candidate": eligibility here is deterministic and
 * structural — semantic worth is decided later by extraction/conflict.
 */
export interface IMemoryCandidate {
    /** Where the candidate came from. Phase 4D is execution-only. */
    source: "execution";

    planId: string;
    stepId: string;

    kind: PlanStepKind;

    tool?: string;
    action?: string;

    goal: string;

    /** Structured machine-readable content — never the formatted [Execution] text. */
    content: unknown;
}

/** Which step kinds / statuses are eligible to produce candidates (4D.6). */
export interface ICandidateEligibility {
    /** kind === "tool" + completed + output → candidate. Default true. */
    includeTools?: boolean;
    /** kind === "action" + completed + output → candidate. Default true. */
    includeActions?: boolean;
    /**
     * kind === "decision" + completed + output → candidate. Default true, but
     * the kind is preserved because a planner decision is not necessarily a
     * user fact.
     */
    includeDecisions?: boolean;
    /**
     * kind === "response" → candidate. Default FALSE: generated language is
     * not necessarily new information.
     */
    includeResponses?: boolean;
}

/**
 * Converts canonical execution results into memory candidates.
 * Deterministic, side-effect free, and Neo4j-unaware by design.
 */
export interface IExecutionResultProcessor {
    process(result: IPlanExecutionResult): IMemoryCandidate[];
}