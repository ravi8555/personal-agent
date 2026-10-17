/**
 * Phase 4F — MemoryPipeline: ORCHESTRATION ONLY.
 *
 *     IMemoryFact[]
 *         │  (4F.3) adapter → Phase 3 normalization
 *         ▼
 *     INormalizedRelation[]
 *         │  (4F.4) ConflictDetector — DELEGATED
 *         ▼
 *     IConflictAnalysis
 *         │  (4F.5) FeedbackEngine — DELEGATED
 *         ▼
 *     IFeedback[]
 *         │  (4F.6) Neo4jMemoryStore — only now
 *         ▼
 *     IMemoryPipelineResult
 *
 * This module implements NO conflict semantics, NO feedback semantics and NO
 * persistence rules. It wires the existing Phase 3 components together in the
 * order your 4F diagram specifies (normalize → conflict → feedback → store),
 * which is deliberately the safe order: a fact may only reach Neo4j after the
 * pipeline has decided what should happen to it (4F.9 — IMemoryFact is NOT a
 * guaranteed write).
 */
import { deduplicateRelations } from "../graphNormalization.js";
import type { INormalizedRelation } from "../graphNormalization.js";
import { detectConflicts } from "../conflictDetector.js";
import type { IConflictAnalysis, IConflictFinding } from "../conflictDetector.js";
import { decideFeedback } from "../feedbackEngine.js";
import type { IFeedback } from "../feedbackEngine.js";
import type { IExtractedRelation } from "../memoryExtraction.js";
import type { IMemoryExtraction } from "../memoryExtraction.js";
import type { IRetrievedRelation } from "../graphRetrieval.js";
import type { IMemoryFact } from "../memory/extractionTypes.js";
import type { ISelfCorrectionReport } from "../selfCorrection.js";
import { MemoryFactNormalizer } from "./memoryFactNormalizer.js";
import type { IMemoryFactNormalizer } from "./memoryFactNormalizer.js";
import { MemoryPipelineError } from "./memoryPipelineError.js";
import type {
    HistoricalRelationsLoader,
    IMemoryFactStore,
    IMemoryPipeline,
    IMemoryPipelineResult,
    ISelfCorrectionPort,
} from "./memoryPipelineTypes.js";

/** Optional persistence gate (4F.9). Default: allow (matches Phase 3). */
export type ShouldPersist = (
    relation: INormalizedRelation,
    findings: readonly IConflictFinding[],
) => boolean;

export interface IMemoryPipelineDeps {
    /** Defaults to the Phase 3 adapter (fact → normalizeRelation). */
    normalizer?: IMemoryFactNormalizer;
    /** Omit for dry runs / unit tests (persisted stays 0). */
    store?: IMemoryFactStore;
    /** Loads historical relations for conflict detection. Defaults to []. */
    historical?: HistoricalRelationsLoader;
    /** Override for tests. Defaults to Phase 3 `detectConflicts`. */
    detect?: (input: {
        current: readonly INormalizedRelation[];
        historical: readonly IRetrievedRelation[];
        evidence?: readonly string[];
    }) => IConflictAnalysis;
    /** Override for tests. Defaults to Phase 3 `decideFeedback`. */
    feedback?: (finding: IConflictFinding) => IFeedback;
    /** Persistence gate. Default: persist every normalized relation. */
    shouldPersist?: ShouldPersist;
    /**
     * 4G: opt-in self-correction port (the EXISTING SelfCorrectionEngine, NOT a
     * second engine). When injected, approved superseding corrections run AFTER
     * persistence — because the existing engine only DELETES superseded
     * historical edges and assumes the new relation was already written. Omit
     * to keep Phase 4F behavior unchanged.
     */
    selfCorrection?: ISelfCorrectionPort;
    /** ISO timestamp source (tests inject a fixed clock). */
    now?: () => string;
}

export class MemoryPipeline implements IMemoryPipeline {
    private readonly normalizer: IMemoryFactNormalizer;
    private readonly store?: IMemoryFactStore;
    private readonly historical?: HistoricalRelationsLoader;
    private readonly detect: IMemoryPipelineDeps["detect"];
    private readonly feedback: IMemoryPipelineDeps["feedback"];
    private readonly shouldPersist: ShouldPersist;
    private readonly now: () => string;
    private readonly selfCorrection?: ISelfCorrectionPort;

    private latestRelations: readonly INormalizedRelation[] = [];
    private latestFindings: readonly IConflictFinding[] = [];
    private latestFeedback: readonly IFeedback[] = [];
    private latestCorrection: ISelfCorrectionReport | null = null;

    constructor(deps: IMemoryPipelineDeps = {}) {
        this.normalizer = deps.normalizer ?? new MemoryFactNormalizer();
        if (deps.store) this.store = deps.store;
        if (deps.historical) this.historical = deps.historical;
        this.detect = deps.detect ?? detectConflicts;
        this.feedback = deps.feedback ?? decideFeedback;
        this.shouldPersist = deps.shouldPersist ?? (() => true);
        if (deps.selfCorrection) this.selfCorrection = deps.selfCorrection;
        this.now = deps.now ?? (() => new Date().toISOString());
    }

    /** The normalized relations from the last run (diagnostics / provenance). */
    public getLatestRelations(): readonly INormalizedRelation[] {
        return this.latestRelations;
    }

    /** Conflict findings from the last run — `current` carries provenance (4F.8). */
    public getLatestFindings(): readonly IConflictFinding[] {
        return this.latestFindings;
    }

    /** Feedback decisions from the last run (4F.5 delegation evidence). */
    public getLatestFeedback(): readonly IFeedback[] {
        return this.latestFeedback;
    }

    /**
     * 4G: the SelfCorrectionEngine report from the last run, or null when no
     * corrections ran (no port injected, or no conflicts). `conflicts` counts
     * detections; this report's `mutationsApplied` is the authoritative tally of
     * graph mutations actually executed (surfaced as `result.corrected`).
     */
    public getLatestCorrection(): ISelfCorrectionReport | null {
        return this.latestCorrection;
    }

    /**
     * 4F chain: normalize → conflict → feedback → persist.
     * Never: fact → Neo4j directly.
     */
    public async process(facts: IMemoryFact[]): Promise<IMemoryPipelineResult> {
        const result: IMemoryPipelineResult = {
            received: Array.isArray(facts) ? facts.length : 0,
            normalized: 0,
            persisted: 0,
            conflicts: 0,
            rejected: 0,
            corrected: 0,
        };
        this.latestRelations = [];
        this.latestFindings = [];
        this.latestFeedback = [];
        this.latestCorrection = null;

        // 4F.9: zero facts → no normalization, no conflict, NO persistence.
        if (!Array.isArray(facts) || facts.length === 0) return result;

        // 1. Normalize — delegate to Phase 3 via the 4F.3 adapter.
        const normalized: INormalizedRelation[] = [];
        for (const fact of facts) {
            const relation = this.normalizer.normalize(fact);
            if (!relation) {
                result.rejected++;
                continue;
            }
            result.normalized++;
            normalized.push(relation);
        }
        if (normalized.length === 0) return result;

        const deduped = deduplicateRelations(normalized);
        this.latestRelations = deduped;

        // 2. Historical relations — injected port (mocked in unit tests).
        const subjects = [...new Set(deduped.map(relation => relation.subject))];
        const historical: IRetrievedRelation[] = this.historical
            ? await this.historical(subjects)
            : [];

        // 3. Conflict detection — DELEGATED to Phase 3 (4F.4).
        const evidence = facts.map(fact => `${fact.subject} ${fact.predicate} ${fact.object}`);
        const analysis: IConflictAnalysis = (this.detect as NonNullable<IMemoryPipelineDeps["detect"]>)({
            current: deduped,
            historical,
            evidence,
        });
        this.latestFindings = analysis.findings;
        result.conflicts = analysis.findings.length;

        // 4. Feedback — DELEGATED to Phase 3 (4F.5).
        this.latestFeedback = analysis.findings.map(finding =>
            (this.feedback as NonNullable<IMemoryPipelineDeps["feedback"]>)(finding),
        );

        // 5. Persist — ONLY after the pipeline decided (4F.6), and only what
        //    the persistence gate allows (4F.9: IMemoryFact ≠ guaranteed write).
        //    4I: a store rejection is wrapped as a typed "persistence" failure.
        //    The store writes ONE transaction, so nothing landed — persistedFacts
        //    0 tells the caller the graph is known unchanged.
        const toPersist = deduped.filter(relation => this.shouldPersist(relation, analysis.findings));
        if (this.store && toPersist.length > 0) {
            try {
                await this.store.saveExtraction(this.buildExtraction(toPersist));
            } catch (error) {
                throw new MemoryPipelineError("persistence", error, 0);
            }
            result.persisted = toPersist.length;
        }

        // 6. Self-correction — DELEGATED to the EXISTING SelfCorrectionEngine
        //    (4G). Opt-in: runs only when the port is injected AND a conflict was
        //    detected. It runs AFTER persistence because the existing engine only
        //    DELETES superseded historical edges — it assumes the new relation was
        //    already written. `mutationsApplied` is the authoritative count of
        //    graph mutations actually executed; a CONFLICTING finding is detected
        //    (counts in `conflicts`) but kept, so it never increments `corrected`.
        if (this.selfCorrection && analysis.findings.length > 0) {
            let report: ISelfCorrectionReport;
            try {
                report = await this.selfCorrection.applyCorrections(analysis.findings);
            } catch (error) {
                // 4I partial-write hardening: persistence ALREADY succeeded —
                // the facts are in the graph even though this run rejects.
                // persistedFacts > 0 → graphMayHaveChanged → the Agent may refresh.
                throw new MemoryPipelineError("correction", error, result.persisted);
            }
            this.latestCorrection = report;
            result.corrected = report.mutationsApplied;
        }

        return result;
    }

    /**
     * Adapt normalized relations into the Phase 3 write shape. `summary`,
     * `facts` and `feedback` stay empty — `buildWriteQueries` skips empty
     * collections, so ONLY entities + RELATES_TO edges are written. Conversation
     * summaries/feedback text nodes remain the conversation path's concern.
     */
    private buildExtraction(relations: readonly INormalizedRelation[]): IMemoryExtraction {
        return {
            summary: "",
            facts: [],
            relations: relations.map(relation => relation as IExtractedRelation),
            feedback: [],
            extractedAt: this.now(),
        };
    }
}

/** Convenience factory matching the codebase's create* pattern. */
export function createMemoryPipeline(deps: IMemoryPipelineDeps = {}): MemoryPipeline {
    return new MemoryPipeline(deps);
}

