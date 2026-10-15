/**
 * Phase 4F — memory pipeline boundary types (ORCHESTRATION ONLY).
 *
 * 4F input is `IMemoryFact[]` and nothing else. It never sees
 * `IPlanExecutionResult` / `IStepResult` / `IMemoryCandidate` / registries —
 * it does not know HOW facts were produced. That is what lets the two sources
 * converge later:
 *
 *   Conversation → Conversation Memory Extractor ─┐
 *                                                 ├→ IMemoryFact[] → 4F
 *   Execution → 4D → 4E ──────────────────────────┘
 *
 * 4F performs NO conflict/feedback/persistence semantics of its own. It
 * DELEGATES to the existing Phase 3 components:
 *   normalization  → graphNormalization
 *   conflict       → ConflictDetector
 *   feedback       → FeedbackEngine
 *   persistence    → Neo4jMemoryStore
 *
 * The chain is fixed (4F.9): Execution → Candidate → Fact → Normalize →
 * Conflict → Feedback → Neo4j.  NEVER Execution → Neo4j.
 */
import type { IMemoryFact } from "../memory/extractionTypes.js";
import type { IRetrievedRelation } from "../graphRetrieval.js";
import type { IMemoryExtraction } from "../memoryExtraction.js";
import type { IConflictFinding } from "../conflictDetector.js";
import type { ISelfCorrectionReport } from "../selfCorrection.js";

/**
 * What happened while processing these semantic facts (4F.7 / 4G).
 * An orchestration tally — deliberately NOT another memory representation.
 */
export interface IMemoryPipelineResult {
    /** Facts handed to the pipeline. */
    received: number;
    /** Facts that normalized into a usable relation (non-null). */
    normalized: number;
    /** Relations actually handed to the store (0 when nothing persisted). */
    persisted: number;
    /** Conflict findings produced by the existing ConflictDetector. */
    conflicts: number;
    /** Facts rejected during normalization (unusable subject/predicate/object). */
    rejected: number;
    /**
     * 4G: graph mutations APPLIED by the existing SelfCorrectionEngine.
     * `conflicts` = detected; `corrected` = approved + executed. A CONFLICTING
     * finding is detected but deliberately kept, so it counts in `conflicts`
     * and never in `corrected`.
     */
    corrected: number;
}

/**
 * Port for fetching historical relations (for conflict detection). Injected so
 * 4F stays orchestration-only: unit tests mock it, the real path adapts the
 * existing GraphKnowledgeRetriever.
 */
export type HistoricalRelationsLoader = (
    subjects: readonly string[],
) => Promise<IRetrievedRelation[]>;

/** The 4F pipeline: semantic facts in, orchestration tally out. */
export interface IMemoryPipeline {
    process(facts: IMemoryFact[]): Promise<IMemoryPipelineResult>;
}

/**
 * Port for the persistence step (4F.6). Structurally `Neo4jMemoryStore`, but
 * declared here so unit tests can inject a recording double without touching
 * the driver. This is the ONLY place in 4F allowed to reach storage.
 */
export interface IMemoryFactStore {
    saveExtraction(extraction: IMemoryExtraction): Promise<void>;
}

/**
 * 4G integration boundary: a NARROW port over the EXISTING
 * `SelfCorrectionEngine` (this is NOT a second correction engine — the only
 * implementation is `createSelfCorrectionEngine(store)`).
 *
 * Opt-in: `MemoryPipeline` runs corrections only when this is injected, so
 * Phase 4F callers are unchanged by default. The Agent's composition layer
 * owns the default wiring.
 */
export interface ISelfCorrectionPort {
    applyCorrections(findings: readonly IConflictFinding[]): Promise<ISelfCorrectionReport>;
}
