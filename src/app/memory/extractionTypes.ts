/**
 * Phase 4E — Memory Extraction types (the SEMANTIC boundary).
 *
 *   4D answered: which execution outputs are CANDIDATES?
 *   4E answers:  what facts/relations can be EXTRACTED from them?
 *
 *   IMemoryCandidate = structured execution output   (structural, deterministic)
 *   IMemoryFact      = semantic interpretation       (this layer, confidence)
 *
 * INPUT BOUNDARY (4E.1) — deliberately narrow. The extractor receives ONLY an
 * `IMemoryCandidate`. It never receives `IPlanExecutionResult` / `IStepResult`,
 * a ToolRegistry, an ActionRegistry, a MemoryStore or the Neo4j driver.
 *
 * OUTPUT BOUNDARY (4E.9) — `ICandidateExtraction` only. Nothing is persisted
 * here; conflict detection, feedback and Neo4j are downstream (4F+), so the
 * Phase 3.11 rule holds: MCP/tool results never bypass extraction/conflict.
 *
 * NAMING: the legacy conversation-batch pipeline
 * (`src/app/memoryExtraction.ts`) already owns `IMemoryExtractor` /
 * `IMemoryExtraction` for `IMessage[]` batches. These execution-scoped types
 * are named `ICandidateMemoryExtractor` / `ICandidateExtraction` so two
 * different shapes never share one name.
 */
import type { IMemoryCandidate } from "../execution/executionResultTypes.js";
import type { PlanStepKind } from "../planTypes.js";

/**
 * A semantic interpretation of a candidate (4E.2/4E.8).
 * Provenance is stamped by the extractor from the candidate — never invented.
 */
export interface IMemoryFact {
    subject: string;
    predicate: string;
    object: string;

    /** Extraction-layer confidence in [0,1] (4E.8) — 4D stays deterministic. */
    confidence: number;

    source: "execution";
    planId: string;
    stepId: string;

    kind: PlanStepKind;
    tool?: string;
    action?: string;
}

/** A triple as produced by a rule, before provenance is stamped. */
export interface IExtractedTriple {
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
}

/** Result of extracting one candidate (4E.2). */
export interface ICandidateExtraction {
    source: "execution";

    planId: string;
    stepId: string;

    /**
     * Facts extracted from this candidate. May legitimately be EMPTY:
     * structured output does not automatically equal memory (4E.4).
     */
    facts: IMemoryFact[];

    /** The candidate that was interpreted — structured output preserved. */
    rawCandidate: IMemoryCandidate;
}

/**
 * An explicit extraction rule (4E.4). Rules are the whole point of the
 * deterministic extractor: `{ picked: [...] }` must NOT become arbitrary
 * relationships — only a rule that knows the semantics may emit facts.
 */
export interface IExtractionRule {
    /** Stable id, surfaced for debugging/provenance. */
    id: string;
    /** Which candidates this rule applies to. */
    matches(candidate: IMemoryCandidate): boolean;
    /** Triples this rule derives (before provenance stamping). */
    extract(candidate: IMemoryCandidate): IExtractedTriple[];
}

/**
 * Provider-independent extractor interface (4E.3). Implementations:
 * deterministic (now), LLM-backed / hybrid (later) — but never hard-wired to
 * a provider, and never given anything wider than a candidate.
 */
export interface ICandidateMemoryExtractor {
    extract(candidate: IMemoryCandidate): Promise<ICandidateExtraction>;
    /** Rule ids this extractor runs (deterministic introspectability). */
    ruleIds(): string[];
}