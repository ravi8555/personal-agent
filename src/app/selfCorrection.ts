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
import { decideFeedback } from './feedbackEngine.js'
import type { FeedbackAction } from './feedbackEngine.js'
import type { IQueryRunner, IGraphQueryResult } from './graphRetrieval.js'
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

/**
 * Build the parameterized Cypher that deletes one superseded relation edge.
 * Fully parameterized — entity/predicate values are never inlined.
 */
function supersedeCypher(subject: string, predicate: string, object: string) {
    return `\nMATCH (a:${GRAPH_NODE_LABELS.Entity} {name: $subject})` +
        `-[r:${GRAPH_RELATIONSHIPS.RelatesTo} {predicate: $predicate}]` +
        `->(b:${GRAPH_NODE_LABELS.Entity} {name: $object})\nDELETE r`
}

function describeRelation(subject: string, predicate: string, object: string): string {
    return `${subject} ${predicate} ${object}`
}

/**
 * SelfCorrectionEngine — Step 13 (self-correction rules).
 *
 * Given conflict findings from the ConflictDetector/FeedbackEngine, it decides,
 * per the rules, whether to mutate the graph (delete a superseded historical
 * edge) or keep both edges for user confirmation, and returns a "dynamic agent
 * context" summary that is injected before the next LLM call.
 */
export class SelfCorrectionEngine {
    private readonly runner: IQueryRunner

    constructor(runner: IQueryRunner) {
        this.runner = runner
    }

    /**
     * Apply self-correction rules to a set of conflict findings. Finds an
     * IQueryRunner for the graph, decides each feedback action, and executes
     * the corresponding graph mutation (deletion) when warranted.
     */
    public async applyCorrections(
        findings: readonly IConflictFinding[],
    ): Promise<ISelfCorrectionReport> {
        const corrections: ISelfCorrectionAction[] = []
        let mutationsApplied = 0

        for (const finding of findings) {
            const feedback = decideFeedback(finding)

            if (feedback.action === 'SUPERSEDED') {
                // RULE_SUPERSEDE — the current statement is explicit and newer,
                // so the contradicting HISTORICAL edges are removed. (The new
                // relation was already written as a separate edge by the
                // 3-minute extraction.)
                for (const historical of finding.historical) {
                    const cypher = supersedeCypher(finding.subject, historical.predicate, finding.object)
                    const params: Record<string, unknown> = {
                        subject: finding.subject,
                        predicate: historical.predicate,
                        object: finding.object,
                    }
                    await this.runner.run(cypher, params)
                    mutationsApplied++
                    corrections.push({
                        rule: SELF_CORRECTION_RULES.Supersede,
                        action: 'SUPERSEDED',
                        description: `Removed superseded relation ${describeRelation(historical.subject, historical.predicate, historical.object)}`,
                        cypher,
                        params,
                    })
                }
            } else {
                // RULE_KEEP_CONFLICT (and RULE_INTERNAL_CONFLICT) — no explicit
                // evidence in the current statement, so BOTH edges are kept in
                // the graph and surfaced in the dynamic context for the user to
                // confirm. No graph mutation.
                const current = describeRelation(finding.subject, finding.current.predicate, finding.object)
                const historicalList = finding.historical.map(h =>
                    describeRelation(h.subject, h.predicate, h.object)).join(', ')
                corrections.push({
                    rule: SELF_CORRECTION_RULES.KeepConflict,
                    action: 'CONFLICTING',
                    description: `Kept conflicting relations for confirmation: ${current} vs ${historicalList} (no graph mutation)`,
                })
            }
        }

        const text = this.buildReportText(corrections)
        return { corrections, mutationsApplied, text }
    }

    /** Render the dynamic agent context summary from the applied corrections. */
    private buildReportText(corrections: readonly ISelfCorrectionAction[]): string {
        if (corrections.length === 0) {
            return '[Self-correction] No conflicts to correct.'
        }

        const lines: string[] = ['[Dynamic agent context - self-correction]']
        for (const correction of corrections) {
            lines.push(`- ${correction.rule}: ${correction.description}`)
        }
        return lines.join('\n')
    }
}

/**
 * Build a SelfCorrectionEngine from a store (or any object whose runQuery
 * takes a parameterized query). Mirrors the createGraphKnowledgeRetriever
 * adapter so a real Neo4jMemoryStore can drive the corrections.
 */
export function createSelfCorrectionEngine(runner: {
    runQuery(query: string, params?: Record<string, unknown>): Promise<IGraphQueryResult>
}): SelfCorrectionEngine {
    return new SelfCorrectionEngine({ run: (query, params) => runner.runQuery(query, params) })
}