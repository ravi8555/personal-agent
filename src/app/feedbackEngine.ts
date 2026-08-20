/**
 * FeedbackEngine module — Step 12 (feedback detection / context decision).
 *
 * This is the "Feedback Engine" box in the architecture. Given a conflict
 * finding produced by the ConflictDetector, it interprets *why* the new
 * statement wins and emits a "context decision" that the agent can act on:
 *
 *   ConflictDetector → conflict finding
 *                           │
 *                           ▼
 *                    FeedbackEngine
 *                           │
 *               decideFeedback(finding)
 *                           │
 *                           ▼
 *                   Feedback { context, reason, action }
 *                           │
 *                           ▼
 *                    running context (Step 11)
 *
 * The decision is purely informational at this stage: it records whether the
 * current statement has explicit evidence, whether the historical relation is
 * CONFLICTING (hold for user confirmation) or SUPERSEDED (safe to update in
 * Step 13). The graph itself is NOT mutated here — mutation/self-correction is
 * the separate Step 13.
 */

import type { IConflictFinding } from './conflictDetector.js'

/** How running context should treat the conflicting historical relation. */
export type FeedbackAction = 'SUPERSEDED' | 'CONFLICTING'

export interface IFeedback {
    /** What the agent should tell the user / use as context. */
    context: string
    /** Why this decision was taken. */
    reason: string
    /**
     * 'SUPERSEDED' when the current statement is explicitly backed by evidence
     * and is newer — the old knowledge should be replaced.
     * 'CONFLICTING' when the new statement lacks explicit evidence — keep both
     * and ask the user to resolve.
     */
    action: FeedbackAction
}

/** The feedback engine produced a decision for the given conflict. */
export function decideFeedback(finding: IConflictFinding): IFeedback {
    const currentStatement = `${finding.subject} ${finding.current.predicate} ${finding.object}`
    const historicalStatements = finding.historical
        .map(h => `${h.subject} ${h.predicate} ${h.object}`)
        .join(', ')

    if (finding.explicitEvidence) {
        return {
            action: 'SUPERSEDED',
            context: `You now say "${currentStatement}" (which explicitly contradicts stored knowledge: ${historicalStatements}). I'll record this newer statement as your current belief.`,
            reason: `Current statement has explicit evidence; it supersedes the historical relation.`,
        }
    }

    return {
        action: 'CONFLICTING',
        context: `I have conflicting memories about ${finding.subject} ${finding.object}: ${currentStatement} vs the previously recorded ${historicalStatements}.`,
        reason: `No explicit evidence in the current statement; keeping both for confirmation.`,
    }
}