import assert from 'node:assert/strict'
import { areOpposites, detectConflicts, oppositeOf, summarizeConflict } from '../app/conflictDetector.js'
import { normalizeRelation } from '../app/graphNormalization.js'

/** Build a normalized "current" relation the way Step 6 does. */
function curRel(subject: string, predicate: string, object: string) {
    const rel = normalizeRelation({ subject, predicate, object })
    if (!rel) throw new Error(`invalid relation: ${subject} ${predicate} ${object}`)
    return rel
}

/** Build a retrieved (historical) relation as Step 10 would return it. */
function histRel(subject: string, predicate: string, object: string, confidence = 0.9) {
    return { subject, predicate, object, confidence }
}

let passed = 0

// ---------------------------------------------------------------------------
// Opposition rules
// ---------------------------------------------------------------------------
assert.deepEqual([...oppositeOf('LIKES')], ['DISLIKES'])
assert.equal(areOpposites('LIKES', 'DISLIKES'), true)
assert.equal(areOpposites('DISLIKES', 'LIKES'), true)
assert.equal(areOpposites('PREFERS', 'DISLIKES'), true)
assert.equal(areOpposites('LIKES', 'PREFERS'), false) // likes + prefers are consistent
passed++

// ---------------------------------------------------------------------------
// Steps A-F of the clean-contradiction scenario:
//   A: existing graph has  ravi DISLIKES coffee
//   B: new conversation      "I love coffee."
//   C: memory extraction     ravi LIKES coffee
//   D: graph retrieval       returns both  DISLIKES(coffee) + LIKES(coffee)
//   E: conflict detector     CONFLICT
//   F: current-context       explicitEvidence = YES
// ---------------------------------------------------------------------------
const historical = [histRel('ravi', 'DISLIKES', 'coffee')]
const current = [curRel('Ravi', 'loves', 'Coffee')] // canonicalizes -> LIKES
const evidence = ['I love coffee.']

const analysis = detectConflicts({ current, historical, evidence })
assert.equal(analysis.conflict, true, 'DISLIKES vs LIKES must be a conflict')
assert.equal(analysis.findings.length, 1, 'exactly one finding expected')

const finding = analysis.findings[0]!
assert.equal(finding.current.predicate, 'LIKES')
assert.equal(finding.current.subject, 'ravi')
assert.equal(finding.current.object, 'coffee')
assert.equal(finding.historical[0]!.predicate, 'DISLIKES')
assert.equal(finding.explicitEvidence, true, 'the new statement mentions coffee')

const summary = summarizeConflict(finding)
assert.deepEqual([...summary], [
    'Current user statement: ravi LIKES coffee',
    'Historical knowledge: ravi DISLIKES coffee',
    'Conflict: YES',
    'Current statement has explicit evidence: YES',
])
passed++

// ---------------------------------------------------------------------------
// No conflict: LIKES coffee vs PREFERS coffee (consistent positives).
// ---------------------------------------------------------------------------
const consistent = detectConflicts({
    current: [curRel('Ravi', 'likes', 'coffee')],
    historical: [histRel('ravi', 'PREFERS', 'coffee')],
    evidence: ['I like coffee.'],
})
assert.equal(consistent.conflict, false, 'likes + prefers are not contradictory')
assert.equal(consistent.findings.length, 0)
passed++

// ---------------------------------------------------------------------------
// Implicit evidence: no message mentions "coffee" -> explicitEvidence false,
// but the relation itself still conflicts.
// ---------------------------------------------------------------------------
const implicit = detectConflicts({
    current: [curRel('Ravi', 'loves', 'Coffee')],
    historical: [histRel('ravi', 'DISLIKES', 'coffee')],
    evidence: ['The user changed their mind.'],
})
assert.equal(implicit.conflict, true)
assert.equal(implicit.findings[0]!.explicitEvidence, false, 'coffee not mentioned in evidence')
passed++

// ---------------------------------------------------------------------------
// Internal contradiction: same extraction batch contains both LIKES & DISLIKES.
// ---------------------------------------------------------------------------
const internal = detectConflicts({
    current: [curRel('Ravi', 'loves', 'Coffee'), curRel('Ravi', 'hates', 'Coffee')],
    historical: [],
    evidence: ['I love coffee.'],
})
assert.equal(internal.conflict, true)
assert.equal(internal.findings.length, 1)
assert.equal(internal.findings[0]!.current.predicate, 'LIKES')
assert.equal(internal.findings[0]!.historical[0]!.predicate, 'DISLIKES')
assert.equal(internal.findings[0]!.explicitEvidence, true)
passed++

// ---------------------------------------------------------------------------
// Explicit-evidence false-positive regression (substring vs whole-token):
// a loose .includes() match would wrongly flag these as explicit.
// ---------------------------------------------------------------------------
{
    // "tea" appears in "steak" and "team" as a substring, but not as a token.
    const a = detectConflicts({
        current: [curRel('Ravi', 'likes', 'tea')],
        historical: [histRel('ravi', 'DISLIKES', 'tea')],
        evidence: ['The team eats steak.'],
    })
    assert.equal(a.conflict, true)
    assert.equal(a.findings[0]!.explicitEvidence, false, 'tea hidden inside team/steak is NOT explicit evidence')

    const b = detectConflicts({
        current: [curRel('Ravi', 'likes', 'tea')],
        historical: [histRel('ravi', 'DISLIKES', 'tea')],
        evidence: ['I drink tea every morning.'],
    })
    assert.equal(b.findings[0]!.explicitEvidence, true, 'whole-word mention of tea IS explicit evidence')

    // multi-word object matched as a whole phrase via the public API
    const c = detectConflicts({
        current: [curRel('Ravi', 'likes', 'new york')],
        historical: [histRel('ravi', 'DISLIKES', 'new york')],
        evidence: ['I am moving to New York soon.'],
    })
    assert.equal(c.findings[0]!.explicitEvidence, true, 'multi-word phrase mention is explicit')
    const d = detectConflicts({
        current: [curRel('Ravi', 'likes', 'new york')],
        historical: [histRel('ravi', 'DISLIKES', 'new york')],
        evidence: ['I am moving to a new yorking city.'],
    })
    assert.equal(d.findings[0]!.explicitEvidence, false, 'new york not a whole phrase here')
    passed++
}

// ---------------------------------------------------------------------------
// empty input -> no conflict
// ---------------------------------------------------------------------------
const empty = detectConflicts({ current: [], historical: [], evidence: [] })
assert.equal(empty.conflict, false)
passed++

console.log(`✅ conflictDetector-test: ${passed} assertions passed`)
