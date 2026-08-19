/**
 * GraphNormalization module — Step 6 of the memory architecture.
 *
 * The extractor (Step 4) emits free-form subjects, predicates and objects.
 * Before they can be stored as RELATES_TO edges (Step 5 schema), the
 * predicates must be normalized to a **controlled canonical vocabulary** so
 * that synonymous phrasings collapse to the same value. This makes
 * deduplication (Step 8) and targeted retrieval (Steps 9-10) deterministic.
 *
 *   "lives in" / "resides in" / "moved to"  ->  LIVES_IN
 *   "likes" / "enjoys" / "prefers"          ->  LIKES
 *
 * Anything that matches no rule keeps its cleaned raw form (marked
 * canonicalPredicate:false) so no extracted relation is ever dropped.
 */

import type { IExtractedRelation } from './memoryExtraction.js'
import { entityKey } from './graphSchema.js'

export interface ICanonicalPredicateDef {
    /** Value stored as RELATES_TO.predicate. */
    key: string
    /** Alternative phrasings that collapse to this key. */
    aliases: readonly string[]
}

export interface INormalizedRelation {
    /** entityKey(subject) — aligned with the Entity.name graph key. */
    subject: string
    /** Canonical predicate when matched, otherwise the cleaned raw predicate. */
    predicate: string
    /** entityKey(object) — aligned with the Entity.name graph key. */
    object: string
    /** True when the predicate matched the controlled vocabulary. */
    canonicalPredicate: boolean
    /** Optional model confidence in [0,1]. */
    confidence?: number
}

export interface IPredicateNormalization {
    predicate: string
    canonical: boolean
}

export const CANONICAL_PREDICATES = [
    {
        key: 'LIVES_IN',
        aliases: [
            'lives in', 'lives at', 'resides in', 'resides at', 'stays in',
            'stays at', 'based in', 'settled in', 'is from', 'hails from',
            'located in', 'moved to', 'moving to', 'relocated to',
        ],
    },
    {
        key: 'LIKES',
        aliases: [
            'likes', 'likes to', 'enjoys', 'loves', 'loves to', 'is fond of',
            'enjoys drinking', 'enjoys eating', 'favourite', 'favorite',
        ],
    },
    {
        key: 'PREFERS',
        aliases: ['prefers', 'would rather', 'prefers to', 'favorites', 'favors'],
    },
    {
        key: 'DISLIKES',
        aliases: [
            'dislikes', 'hates', 'does not like', 'doesn\'t like', 'avoids',
            'not a fan of',
        ],
    },
    {
        key: 'WORKS_AT',
        aliases: ['works at', 'works in', 'works for', 'employed at', 'is employed at'],
    },
    {
        key: 'WORKS_AS',
        aliases: ['works as', 'employed as', 'is employed as', 'works a job as'],
    },
    {
        key: 'OWNS',
        aliases: ['owns', 'has', 'possesses'],
    },
    {
        key: 'IS',
        aliases: ['is', 'is a', 'is an', 'are', 'is classified as'],
    },
    {
        key: 'PART_OF',
        aliases: ['part of', 'belongs to', 'member of'],
    },
    {
        key: 'KNOWS',
        aliases: ['knows', 'knows about', 'is familiar with'],
    },
    {
        key: 'MARRIED_TO',
        aliases: ['married to', 'spouse of'],
    },
    {
        key: 'FRIEND_OF',
        aliases: ['friend of', 'friends with'],
    },
    {
        key: 'NEAR',
        aliases: ['near', 'close to', 'adjacent to', 'nearby'],
    },
    {
        key: 'ASSOCIATED_WITH',
        aliases: ['associated with', 'linked to', 'related to', 'connected with'],
    },
] as const satisfies readonly ICanonicalPredicateDef[]

export type CanonicalPredicate = (typeof CANONICAL_PREDICATES)[number]['key']

const ALIAS_TO_KEY: ReadonlyMap<string, string> = new Map(
    CANONICAL_PREDICATES.flatMap(def =>
        def.aliases.map(alias => [alias, def.key] as [string, string]),
    ),
)

const CANONICAL_KEY_BY_LOWER: ReadonlyMap<string, string> = new Map(
    CANONICAL_PREDICATES.map(def => [def.key.toLowerCase(), def.key] as [string, string]),
)

/** Collapse case and whitespace for matching. */
function normalizeToken(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** True when the given value is one of the controlled canonical predicates. */
export function isCanonicalPredicate(predicate: string): boolean {
    return CANONICAL_KEY_BY_LOWER.has(normalizeToken(predicate))
}

/**
 * Resolve a raw predicate to its canonical form. Returns { predicate, canonical }
 * where predicate is the canonical key when a rule matches (canonical:true), or
 * the cleaned raw form otherwise (canonical:false).
 */
export function normalizePredicate(raw: string): IPredicateNormalization {
    const token = normalizeToken(raw)
    if (!token) return { predicate: '', canonical: false }

    const hit = ALIAS_TO_KEY.get(token)
    if (hit) return { predicate: hit, canonical: true }

    // Already a canonical key (e.g. the model emitted LIVES_IN directly).
    const existing = CANONICAL_KEY_BY_LOWER.get(token)
    if (existing) return { predicate: existing, canonical: true }

    return { predicate: token, canonical: false }
}

/**
 * Normalize one extracted relation: entity keys for subject/object and a
 * canonical predicate. Returns null when the relation has no usable
 * subject/object/predicate.
 */
export function normalizeRelation(relation: IExtractedRelation): INormalizedRelation | null {
    const subject = entityKey(relation.subject)
    const object = entityKey(relation.object)
    if (!subject || !object) return null

    const { predicate, canonical } = normalizePredicate(relation.predicate)
    if (!predicate) return null

    const result: INormalizedRelation = { subject, predicate, object, canonicalPredicate: canonical }
    if (relation.confidence !== undefined) result.confidence = relation.confidence
    return result
}

/** Normalize a batch of extracted relations, dropping unusable ones. */
export function normalizeRelations(
    relations: readonly IExtractedRelation[],
): INormalizedRelation[] {
    return relations
        .map(normalizeRelation)
        .filter((relation): relation is INormalizedRelation => relation !== null)
}

/**
 * Remove exact duplicates (same subject, predicate and object) so a single
 * extraction never writes the same relation twice. Graph-level dedup is still
 * enforced by MERGE on (subject, predicate, object) in Step 7/8.
 */
export function deduplicateRelations(
    relations: readonly INormalizedRelation[],
): INormalizedRelation[] {
    const seen = new Set<string>()
    const result: INormalizedRelation[] = []
    for (const relation of relations) {
        const key = `${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push(relation)
    }
    return result
}