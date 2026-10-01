/**
 * Phase 4E — deterministic memory extractor (the no-LLM implementation).
 *
 * A thin, fixed-rule specialisation of {@link MemoryExtractor}: same math,
 * same boundary, no provider. This is the "deterministic extractor" branch of
 * the 4E.3 diagram:
 *
 *   ICandidateMemoryExtractor
 *        ├── DeterministicMemoryExtractor   ← this file
 *        └── (future) LLM / hybrid extractor
 *
 * An LLM extractor may be added LATER behind the same interface — it does not
 * get to redefine the pipeline, and it still receives only an IMemoryCandidate.
 *
 * Like its siblings in memory/, this module performs NO Neo4j writes and holds
 * no MemoryStore: conflict detection + feedback + persistence are 4F+.
 */
import { MemoryExtractor, createDefaultExtractionRules } from "./memoryExtractor.js";
import type { IExtractionRule } from "./extractionTypes.js";

export class DeterministicMemoryExtractor extends MemoryExtractor {
    constructor(rules: readonly IExtractionRule[] = createDefaultExtractionRules()) {
        super(rules);
    }
}

/** Convenience factory matching the codebase's create* pattern. */
export function createDeterministicMemoryExtractor(
    rules: readonly IExtractionRule[] = createDefaultExtractionRules(),
): DeterministicMemoryExtractor {
    return new DeterministicMemoryExtractor(rules);
}