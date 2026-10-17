/**
 * Phase 4I — typed failure for the execution-memory pipeline (4F/4G).
 *
 * Why this exists: a pipeline run has GRAPH SIDE EFFECTS — it persists
 * relations, THEN self-corrects. When `process()` rejects, the caller (the
 * Agent) needs to know whether the graph may have changed, not merely that
 * something failed:
 *
 *   stage "persistence" → the store write FAILED. `Neo4jMemoryStore` writes
 *     every relation in ONE transaction, so a rejection rolls everything
 *     back: `persistedFacts: 0` → graph KNOWN UNCHANGED.
 *   stage "correction"  → persistence already SUCCEEDED (the relations
 *     landed); the existing SelfCorrectionEngine then failed mid-run. The
 *     new facts ARE in the graph: `persistedFacts > 0` → GRAPH MAY HAVE
 *     CHANGED. This is the partial-write case the Agent must refresh for.
 *
 * Pre-persist stages (historical load, conflict detection, feedback,
 * normalization) are NOT wrapped: they cannot have written anything, so raw
 * propagation already means "nothing landed" — and the Agent's default for
 * unknown errors is likewise unchanged (no refresh, pre-4H guarantee intact).
 *
 * Contract preserved: `process()` still REJECTS on failure. This error merely
 * carries structured diagnostics (stage + persistedFacts) alongside the
 * original message and cause.
 */
export type MemoryPipelineStage = "persistence" | "correction";

export class MemoryPipelineError extends Error {
    /** Which graph-affecting stage failed. */
    public readonly stage: MemoryPipelineStage;
    /** Relations handed to the store before the failure (0 = nothing landed). */
    public readonly persistedFacts: number;
    public readonly cause: unknown;

    constructor(stage: MemoryPipelineStage, cause: unknown, persistedFacts = 0) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "MemoryPipelineError";
        this.stage = stage;
        this.persistedFacts = persistedFacts;
        this.cause = cause;
    }

    /**
     * Conservative graph-change signal for the Agent's refresh decision (4I):
     * true once ANY write may have landed — a correction-stage failure (the
     * facts were persisted before corrections ran) or a non-atomic store that
     * reports partial progress.
     */
    public get graphMayHaveChanged(): boolean {
        return this.stage === "correction" || this.persistedFacts > 0;
    }
}

/** Type guard — Agent-side refresh decisions narrow with this. */
export function isMemoryPipelineError(error: unknown): error is MemoryPipelineError {
    return error instanceof MemoryPipelineError;
}
