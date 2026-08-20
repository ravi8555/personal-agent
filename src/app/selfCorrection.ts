/**
 * SelfCorrection module — Step 13 of the memory architecture.
 *
 * The "Self-Correction Rules" box. After the FeedbackEngine (Step 12) decides
 * whether a detected conflict is SUPERSEDED or CONFLICTING, this engine applies
 * explicit correction rules to the graph and produces the "dynamic agent
 * context" summary that feeds the next LLM call.
 *
 * Rules (applied with the EXISTING schema — no status properties yet):
 *
 *   RULE_SUPERSEDE — Feedback action SUPERSEDED:
 *                     the current statement is explicit and newer, so the
 *                     contradicting HISTORICAL relation edges are removed from
 *                     the graph (the new relation was already written by the
 *                     3-minute extraction as a separate edge).
 *   RULE_KEEP_CONFLICT — Feedback action CONFLICTING:
 *                     no explicit evidence in the current statement, so both
 *                     edges are KEPT in the graph and surfaced in the dynamic
 *                     context for user confirmation.
 *   RULE_INTERNAL_CONFLICT — conflicts discovered within a single extraction
 *                     batch: no graph mutation (both relations were written);
 *                     surfaced for user confirmation.
 *
 * No PERMANENT/TEMPORARY/CONTEXTUAL/SUPERSEDED/CONFLICTING status labels are
 * added to RELATES_TO yet — that is deliberately deferred. Mutations here are
 * edge deletions only.
 */

import type { IConflictFinding } from './conflictDetector.js'
import type { IFeedback, FeedbackAction } from './feedbackEngine.js'
import type { IQueryRunner } from './graphRetrieval.js'
import { GRAPH_NODE_LABELS, GRAPH_RELATIONSHIPS } from './graphSchema.js'

/** The named self-correction rules applied by this engine. */
export const SELF_CORRECTION_RULES = {
    Supersede: 'RULE_SUPERSEDE',
    KeepConflict: 'RULE_KEEP_CONFLICT',
    InternalConflict: 'RULE_INTERNAL_CONFLICT',
} as const

export type SelfCorrectionRule =
    (typeof SELF_CORRECTION_RULES)[keyof typeof SELF_CORRECTION_RULES]

export interface ISelfCorrectionAction {
    /** Which rule produced this action. */
    rule: SelfCorrectionRule
    /** SUPERSEDED edges were deleted; CONFLICTING edges were kept. */
    action: FeedbackAction
    /** Human-readable description of what was done. */
    description: string
    /** Cypher mutation to run. Absent for CONFLICTING (keep) actions. */
    cypher?: string
    /** Parameters bound to the mutation. */
    params?: Record<string, unknown>
}

export interface ISelfCorrectionReport {
    /** Every action taken (or deliberately kept). */
    corrections: readonly ISelfCorrectionAction[]
    /** Number of graph mutations actually executed (edge deletions). */
    mutationsApplied: number
    /** Dynamic agent context summary — the agent sees this before the LLM call. */
    text: string
}

// @PART2