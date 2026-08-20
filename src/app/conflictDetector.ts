/**
 * ConflictDetector module — core of Step 12 (contradiction/feedback detection).
 *
 * Given the freshly extracted relations (3-minute extraction path) and the
 * historical relations retrieved from the graph (context watcher path), it
 * decides whether the new statements CONFLICT with what is already known:
 *
 *   current (new) relations  +  historical (graph) relations
 *                 │
 *                 ▼
 *          ConflictDetector
 *                 │
 *        ┌────────┴────────┐
 *     NO CONFLICT        CONFLICT ──► Feedback Engine (later step)
 *        │                    │
 *        ▼                    ▼
  *   Normal Context       (no conflict)
 *
 * Output is a structured conflict analysis — the current statement vs.
 * historical knowledge, plus explicitEvidence — consumed by the feedback /
 * self-correction layers. No graph mutation happens in this module.
 */

import type { INormalizedRelation } from './graphNormalization.js'
import type { IRetrievedRelation } from './graphRetrieval.js'

/**
 * Which canonical predicates directly contradict each other.
 *
 * NOTE: PREFERS -> DISLIKES is semantically debatable — "I prefer tea over
 * coffee" does not imply DISLIKES(coffee). Per the current test scope we keep
 * it (LIKES<->DISLIKES and PREFERS->DISLIKES only) and deliberately do NOT
 * expand this map further until real behaviour with the coffee case is
 * confirmed.
 */
const OPPOSITES: ReadonlyMap<string, readonly string[]> = new Map([
    ['LIKES', ['DISLIKES']],
    ['DISLIKES', ['LIKES']],
    ['PREFERS', ['DISLIKES']],
])

/** Canonical predicates that directly contradict the given one. */
export function oppositeOf(predicate: string): readonly string[] {
    return OPPOSITES.get(predicate) ?? []
}

/** True when two predicates are direct opposites (LIKES ⇄ DISLIKES). */
export function areOpposites(a: string, b: string): boolean {
    return (OPPOSITES.get(a) ?? []).includes(b)
}

export interface IConflictFinding {
    subject: string
    object: string
    /** The newly extracted relation that contradicts history. */
    current: INormalizedRelation
        /** The historical (or same-batch) relations it contradicts. */
    historical: readonly IRetrievedRelation[]
    /** Whether the current user statement explicitly mentions this fact. */
    explicitEvidence: boolean
}

export interface IConflictAnalysis {
    conflict: boolean
    findings: IConflictFinding[]
}

export interface IConflictDetectionInput {
    /** Freshly extracted relations, after normalization (Step 6). */
    current: readonly INormalizedRelation[]
    /** Historical relations retrieved from the graph (Step 10). */
    historical: readonly IRetrievedRelation[]
    /** Textual evidence for the current statement (facts / user messages). */
    evidence?: readonly string[]
}

/**
 * True when any evidence text mentions the object as a whole token (word
 * boundary). This avoids the false positives of a bare substring match, e.g.
 * object "tea" must not count as matched by "teapot" or "steak".
 */
function mentionsObject(evidence: readonly string[], key: string): boolean {
    if (!key) return false
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, 'i')
    return evidence.some(text => pattern.test(text))
}

function buildFinding(
    current: INormalizedRelation,
    historical: readonly IRetrievedRelation[],
    evidence: readonly string[],
): IConflictFinding {
    const explicitEvidence = mentionsObject(evidence, current.object)

    return {
        subject: current.subject,
        object: current.object,
        current,
        historical,
        explicitEvidence,
    }
}

/**
 * Detect contradictions between the current extraction and the graph, plus
 * internal contradictions inside the current extraction batch itself.
 */
export function detectConflicts(input: IConflictDetectionInput): IConflictAnalysis {
    const findings: IConflictFinding[] = []
    const evidence = input.evidence ?? []

    // Cross-check: current relations vs. historical relations from the graph.
    for (const current of input.current) {
        const conflicting = input.historical.filter(historical =>
            historical.subject === current.subject
            && historical.object === current.object
            && areOpposites(current.predicate, historical.predicate))

        if (conflicting.length > 0) {
            findings.push(buildFinding(current, conflicting, evidence))
        }
    }

    // Internal contradictions within the new extraction batch itself.
    const seenInternal = new Set<string>()
    for (let i = 0; i < input.current.length; i++) {
        const a = input.current[i]
        if (!a) continue
        for (let j = i + 1; j < input.current.length; j++) {
            const b = input.current[j]
            if (!b) continue
            if (a.subject === b.subject && a.object === b.object && areOpposites(a.predicate, b.predicate)) {
                const key = `${a.subject}\u0000${a.object}\u0000${[a.predicate, b.predicate].sort().join('&')}`
                if (seenInternal.has(key)) continue
                seenInternal.add(key)
                const historical: IRetrievedRelation = {
                    subject: b.subject,
                    predicate: b.predicate,
                    object: b.object,
                    confidence: b.confidence ?? null,
                }
                findings.push(buildFinding(a, [historical], evidence))
            }
        }
    }

    return { conflict: findings.length > 0, findings }
}

/**
 * Render one conflict finding in the human-readable form used for tests and
 * for feeding the future feedback engine:
 *
 *   Current user statement: LIKES coffee
 *   Historical knowledge: DISLIKES coffee
 *   Conflict: YES
 *   Current statement has explicit evidence: YES
 */
export function summarizeConflict(finding: IConflictFinding): readonly string[] {
    const currentStatement = `${finding.subject} ${finding.current.predicate} ${finding.object}`
    const historicalStatements = finding.historical.map(
        h => `${h.subject} ${h.predicate} ${h.object}`,
    )
    return [
        `Current user statement: ${currentStatement}`,
        `Historical knowledge: ${historicalStatements.join(', ')}`,
        `Conflict: ${finding.historical.length > 0 ? 'YES' : 'NO'}`,
        `Current statement has explicit evidence: ${finding.explicitEvidence ? 'YES' : 'NO'}`,
    ]
}