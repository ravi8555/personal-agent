/**
 * Phase 4F — boundary adapter: IMemoryFact → Phase 3 normalization.
 *
 * 4F.3: REUSE Phase 3 normalization rather than redesigning it. This module
 * only adapts the fact shape into the existing `IExtractedRelation` input and
 * then delegates to `normalizeRelation()` (entityKey + canonical predicate).
 *
 * No new fact model: `IMemoryFact` stays canonical (4F.2). Provenance is
 * carried into `IExtractedRelation` / `INormalizedRelation` via the additive
 * optional fields added in 4F.8.
 */
import type { IMemoryFact } from "../memory/extractionTypes.js";
import type { IExtractedRelation } from "../memoryExtraction.js";
import { normalizeRelation } from "../graphNormalization.js";
import type { INormalizedRelation } from "../graphNormalization.js";

/**
 * The boundary adapter: fact → the shape the existing normalizer expects.
 * Confidence is required on `IMemoryFact`, so it always survives here.
 */
export function factToRelation(fact: IMemoryFact): IExtractedRelation {
    const relation: IExtractedRelation = {
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
    };
    // 4F.8 provenance — only set what the fact actually carries.
    if (fact.source !== undefined) relation.source = fact.source;
    if (fact.planId !== undefined) relation.planId = fact.planId;
    if (fact.stepId !== undefined) relation.stepId = fact.stepId;
    if (fact.kind !== undefined) relation.kind = fact.kind;
    if (fact.tool !== undefined) relation.tool = fact.tool;
    if (fact.action !== undefined) relation.action = fact.action;
    return relation;
}

/** Adapter contract (4F.3): one fact in, one normalized relation (or null). */
export interface IMemoryFactNormalizer {
    normalize(fact: IMemoryFact): INormalizedRelation | null;
}

/**
 * Default normalizer: adapt, then DELEGATE to Phase 3 `normalizeRelation()`.
 * Returns null when the relation is unusable (same rule as the legacy path).
 */
export class MemoryFactNormalizer implements IMemoryFactNormalizer {
    public normalize(fact: IMemoryFact): INormalizedRelation | null {
        if (!fact) return null;
        return normalizeRelation(factToRelation(fact));
    }
}

/** Convenience factory matching the codebase's create* pattern. */
export function createMemoryFactNormalizer(): MemoryFactNormalizer {
    return new MemoryFactNormalizer();
}