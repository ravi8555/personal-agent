/**
 * Phase 4E — rule-driven memory extractor + default deterministic rules.
 *
 * The engine is provider-independent: it runs an ordered list of EXPLICIT
 * rules (4E.4). A candidate with no matching rule yields zero facts — the
 * principle that structured output does not automatically equal memory.
 *
 * Must stay free of Neo4j / MemoryStore / graphStore / ConflictDetector /
 * FeedbackEngine / OpenAI. Extraction is semantics only; persistence and
 * conflict resolution are downstream (4F+).
 */
import type { IMemoryCandidate } from "../execution/executionResultTypes.js";
import type {
    ICandidateExtraction,
    ICandidateMemoryExtractor,
    IExtractedTriple,
    IExtractionRule,
    IMemoryFact,
} from "./extractionTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/** Tool that yields schedule observations (4E.5). */
export const CALENDAR_LIST_EVENTS_TOOL = "calendar.list_events";

/**
 * Default deterministic rules. Ordered; provenance is stamped by the engine.
 *
 * Deliberately conservative:
 *  - calendar.list_events  → HAS_EVENT / OCCURS_AT observations from OUTPUT
 *  - explicit {subject,predicate,object} output → passthrough (semantic output)
 *  - list.pick / text.summarize_local / note.compose / web.search → NO rule,
 *    so they produce zero facts (a pick is not a preference; a search result
 *    is a reference, not a user fact).
 */
export function createDefaultExtractionRules(): IExtractionRule[] {
    return [
        {
            id: "tool.calendar.list_events",
            matches: candidate =>
                candidate.kind === "tool"
                && candidate.tool === CALENDAR_LIST_EVENTS_TOOL
                && Array.isArray(candidate.content),
            extract: candidate => {
                const triples: IExtractedTriple[] = [];
                for (const entry of candidate.content as unknown[]) {
                    if (!isRecord(entry) || !nonEmptyString(entry["title"])) continue;
                    const title = entry["title"].trim();
                    triples.push({ subject: "user", predicate: "HAS_EVENT", object: title, confidence: 0.7 });
                    if (nonEmptyString(entry["time"])) {
                        triples.push({ subject: title, predicate: "OCCURS_AT", object: entry["time"].trim(), confidence: 0.6 });
                    }
                }
                return triples;
            },
        },
        {
            id: "structural.explicit-triple",
            // A step whose OUTPUT already is a fact (e.g. a semantic action like
            // `preference.record`). Only this explicit shape is accepted — the
            // rule never guesses at nested data.
            matches: candidate =>
                isRecord(candidate.content)
                && nonEmptyString(candidate.content["subject"])
                && nonEmptyString(candidate.content["predicate"])
                && nonEmptyString(candidate.content["object"]),
            extract: candidate => {
                const record = candidate.content as Record<string, unknown>;
                return [{
                    subject: String(record["subject"]).trim(),
                    predicate: String(record["predicate"]).trim(),
                    object: String(record["object"]).trim(),
                    confidence: 0.85,
                }];
            },
        },
    ];
}

/**
 * The deterministic engine: runs rules in order, de-duplicates, and stamps
 * provenance from the candidate (planId/stepId/kind/tool/action).
 */
export class MemoryExtractor implements ICandidateMemoryExtractor {
    private readonly rules: readonly IExtractionRule[];

    constructor(rules: readonly IExtractionRule[] = []) {
        this.rules = rules;
    }

    public ruleIds(): string[] {
        return this.rules.map(rule => rule.id);
    }

    public async extract(candidate: IMemoryCandidate): Promise<ICandidateExtraction> {
        const facts: IMemoryFact[] = [];
        const seen = new Set<string>();

        if (candidate) {
            for (const rule of this.rules) {
                if (!rule.matches(candidate)) continue;
                for (const triple of rule.extract(candidate)) {
                    if (!this.isUsable(triple)) continue;
                    const key = `${triple.subject}|${triple.predicate}|${triple.object}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    facts.push(this.stamp(candidate, triple));
                }
            }
        }

        return {
            source: "execution",
            planId: candidate.planId,
            stepId: candidate.stepId,
            facts,
            rawCandidate: candidate,
        };
    }

    /** A triple is only usable when all three parts survive trimming. */
    private isUsable(triple: IExtractedTriple): boolean {
        return nonEmptyString(triple.subject)
            && nonEmptyString(triple.predicate)
            && nonEmptyString(triple.object);
    }

    /** Provenance comes FROM the candidate — never invented, never from args. */
    private stamp(candidate: IMemoryCandidate, triple: IExtractedTriple): IMemoryFact {
        return {
            subject: triple.subject.trim(),
            predicate: triple.predicate.trim(),
            object: triple.object.trim(),
            confidence: clamp01(triple.confidence),
            source: "execution",
            planId: candidate.planId,
            stepId: candidate.stepId,
            kind: candidate.kind,
            ...(candidate.tool ? { tool: candidate.tool } : {}),
            ...(candidate.action ? { action: candidate.action } : {}),
        };
    }
}

/** Rule-driven extractor with custom rules (tests / future providers). */
export function createMemoryExtractor(rules: readonly IExtractionRule[]): MemoryExtractor {
    return new MemoryExtractor(rules);
}