/**
 * GraphCypher module — Step 7 of the memory architecture.
 *
 * Controlled Cypher generation. Every query produced here is fully
 * parameterized (user/extraction data never appears inline in the Cypher
 * string), uses only label/type constants from the Step-5 schema, and relies
 * on MERGE + unique constraints for upsert/deduplication semantics.
 *
 * A complete extraction is turned into an ordered list of IGraphWriteQuery
 * (entities -> relations -> facts -> summary -> feedback), which
 * Neo4jMemoryStore (Step 8) executes in a single write transaction.
 */

import type { IMemoryExtraction } from './memoryExtraction.js'
import { entityKey, type EntityType, type IEntityNode, GRAPH_NODE_LABELS, GRAPH_RELATIONSHIPS } from './graphSchema.js'
import { deduplicateRelations, normalizeRelations, type INormalizedRelation } from './graphNormalization.js'

export interface IGraphWriteQuery {
    /** Parameterized Cypher statement. */
    cypher: string
    /** Parameters bound to the statement. */
    params: Record<string, unknown>
}

export interface IFactWriteItem {
    factId: string
    text: string
    /** Optional confidence in [0,1]; null means "no value". */
    confidence: number | null
    /** Entity graph keys this fact is ABOUT. */
    entities: readonly string[]
    extractedAt: string
    extractionId: string
}

export interface ISummaryWriteItem {
    summaryId: string
    text: string
    entities: readonly string[]
    extractedAt: string
    extractionId: string
}

export interface IFeedbackWriteItem {
    feedbackId: string
    type: string
    text: string
    entities: readonly string[]
    extractedAt: string
    extractionId: string
}

/** Deterministic string hash (djb2) used to derive stable ids. */
function djb2(text: string): string {
    let hash = 5381
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
    }
    return hash.toString(16)
}

export function makeExtractionId(extraction: Pick<IMemoryExtraction, 'extractedAt' | 'summary' | 'facts'>): string {
    return `ext-${djb2(`${extraction.extractedAt}|${extraction.summary}|${(extraction.facts ?? []).join('|')}`)}`
}

export function makeFactId(text: string): string {
    return `fact-${djb2(text)}`
}

export function makeSummaryId(text: string): string {
    return `summary-${djb2(text)}`
}

export function makeFeedbackId(type: string, text: string): string {
    return `feedback-${djb2(`${type}|${text}`)}`
}

/** Minimal entity-type inference used at write time (refined by the context watcher later). */
export function inferEntityType(entityName: string): EntityType {
    return entityName.toLowerCase() === 'user' ? 'person' : 'concept'
}

/** Which of the known entity keys are mentioned in a text (case-insensitive). */
export function findMentions(text: string, entityKeys: readonly string[]): string[] {
    const lower = text.toLowerCase()
    const result: string[] = []
    for (const key of entityKeys) {
        if (key.length >= 2 && lower.includes(key)) result.push(key)
    }
    return result
}

/** Upsert entities (MERGE on the unique name key). */
export function upsertEntitiesQuery(entities: readonly IEntityNode[]): IGraphWriteQuery {
    return {
        cypher: `
UNWIND $entities AS e
MERGE (n:${GRAPH_NODE_LABELS.Entity} {name: e.name})
SET n.label = e.label,
    n.type = e.type,
    n.createdAt = e.createdAt,
    n.updatedAt = e.updatedAt`,
        params: { entities: entities.map(e => ({ name: e.name, label: e.label, type: e.type, createdAt: e.createdAt, updatedAt: e.updatedAt })) },
    }
}

/** Upsert relation edges, deduped on (subject, predicate, object). */
export function upsertRelationsQuery(
    relations: readonly INormalizedRelation[],
    extractedAt: string,
    extractionId: string,
): IGraphWriteQuery {
    return {
        cypher: `
UNWIND $relations AS r
MATCH (a:${GRAPH_NODE_LABELS.Entity} {name: r.subject})
MATCH (b:${GRAPH_NODE_LABELS.Entity} {name: r.object})
MERGE (a)-[rel:${GRAPH_RELATIONSHIPS.RelatesTo} {predicate: r.predicate}]->(b)
SET rel.confidence = coalesce(r.confidence, rel.confidence),
    rel.extractedAt = r.extractedAt,
    rel.extractionId = r.extractionId`,
        params: {
            relations: relations.map(r => ({
                subject: r.subject,
                predicate: r.predicate,
                object: r.object,
                confidence: r.confidence ?? null,
                extractedAt,
                extractionId,
            })),
        },
    }
}

/** Upsert facts (MERGE on unique text) and link them ABOUT their entities. */
export function upsertFactsQuery(facts: readonly IFactWriteItem[]): IGraphWriteQuery {
    return {
        cypher: `
UNWIND $facts AS f
MERGE (n:${GRAPH_NODE_LABELS.Fact} {text: f.text})
SET n.factId = f.factId,
    n.confidence = coalesce(f.confidence, n.confidence),
    n.extractedAt = f.extractedAt,
    n.extractionId = f.extractionId
WITH n, f
UNWIND f.entities AS entityName
MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: entityName})
MERGE (n)-[rel:${GRAPH_RELATIONSHIPS.About}]->(e)
SET rel.extractedAt = f.extractedAt,
    rel.extractionId = f.extractionId`,
        params: { facts: facts.map(f => ({ factId: f.factId, text: f.text, confidence: f.confidence, entities: f.entities, extractedAt: f.extractedAt, extractionId: f.extractionId })) },
    }
}

/** Insert summaries (MERGE on summaryId) and link them ABOUT their entities. */
export function createSummaryQuery(summaries: readonly ISummaryWriteItem[]): IGraphWriteQuery {
    return {
        cypher: `
UNWIND $summaries AS s
MERGE (n:${GRAPH_NODE_LABELS.Summary} {summaryId: s.summaryId})
SET n.text = s.text,
    n.extractedAt = s.extractedAt,
    n.extractionId = s.extractionId
WITH n, s
UNWIND s.entities AS entityName
MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: entityName})
MERGE (n)-[rel:${GRAPH_RELATIONSHIPS.About}]->(e)
SET rel.extractedAt = s.extractedAt,
    rel.extractionId = s.extractionId`,
        params: { summaries: summaries.map(s => ({ summaryId: s.summaryId, text: s.text, entities: s.entities, extractedAt: s.extractedAt, extractionId: s.extractionId })) },
    }
}

/** Insert feedback (MERGE on feedbackId) and link it ABOUT its entities. */
export function createFeedbackQuery(feedback: readonly IFeedbackWriteItem[]): IGraphWriteQuery {
    return {
        cypher: `
UNWIND $feedback AS fb
MERGE (n:${GRAPH_NODE_LABELS.Feedback} {feedbackId: fb.feedbackId})
SET n.type = fb.type,
    n.text = fb.text,
    n.extractedAt = fb.extractedAt,
    n.extractionId = fb.extractionId
WITH n, fb
UNWIND fb.entities AS entityName
MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: entityName})
MERGE (n)-[rel:${GRAPH_RELATIONSHIPS.About}]->(e)
SET rel.extractedAt = fb.extractedAt,
    rel.extractionId = fb.extractionId`,
        params: { feedback: feedback.map(fb => ({ feedbackId: fb.feedbackId, type: fb.type, text: fb.text, entities: fb.entities, extractedAt: fb.extractedAt, extractionId: fb.extractionId })) },
    }
}

function buildEntities(
    extraction: IMemoryExtraction,
    relations: readonly INormalizedRelation[],
): IEntityNode[] {
    const map = new Map<string, IEntityNode>()
    const extractedAt = extraction.extractedAt

    const ensure = (key: string, display: string) => {
        if (!key) return
        const existing = map.get(key)
        if (!existing) {
            map.set(key, {
                name: key,
                label: display || key,
                type: inferEntityType(key),
                createdAt: extractedAt,
                updatedAt: extractedAt,
            })
        }
    }

    // Original relation casing provides the nicer display labels.
    for (const rel of extraction.relations) {
        ensure(entityKey(rel.subject), rel.subject.trim())
        ensure(entityKey(rel.object), rel.object.trim())
    }
    // Normalized keys guarantee the entities exist even if casing was lost.
    for (const rel of relations) {
        ensure(rel.subject, rel.subject)
        ensure(rel.object, rel.object)
    }

    return [...map.values()]
}

/**
 * Build the ordered, parameterized write queries for one extraction record.
 * Relations are normalized + deduplicated first (Steps 6 + 8 duplicate
 * prevention); everything else is upserted with MERGE keyed on the schema's
 * unique properties.
 */
export function buildWriteQueries(
    extraction: IMemoryExtraction,
    relations: readonly INormalizedRelation[] = normalizeRelations(extraction.relations),
): IGraphWriteQuery[] {
    const dedupedRelations = deduplicateRelations(relations)
    const entities = buildEntities(extraction, dedupedRelations)
    const extractionId = makeExtractionId(extraction)
    const extractedAt = extraction.extractedAt
    const entityKeys = entities.map(e => e.name)

    const queries: IGraphWriteQuery[] = []

    if (entities.length > 0) {
        queries.push(upsertEntitiesQuery(entities))
    }

    if (dedupedRelations.length > 0) {
        queries.push(upsertRelationsQuery(dedupedRelations, extractedAt, extractionId))
    }

    if (extraction.facts.length > 0) {
        queries.push(upsertFactsQuery(extraction.facts.map(text => ({
            factId: makeFactId(text),
            text,
            confidence: null,
            entities: findMentions(text, entityKeys),
            extractedAt,
            extractionId,
        }))))
    }

    if (extraction.summary.length > 0) {
        queries.push(createSummaryQuery([{
            summaryId: makeSummaryId(extraction.summary),
            text: extraction.summary,
            entities: findMentions(extraction.summary, entityKeys),
            extractedAt,
            extractionId,
        }]))
    }

    if (extraction.feedback.length > 0) {
        queries.push(createFeedbackQuery(extraction.feedback.map(fb => ({
            feedbackId: makeFeedbackId(fb.type, fb.text),
            type: fb.type,
            text: fb.text,
            entities: findMentions(fb.text, entityKeys),
            extractedAt,
            extractionId,
        }))))
    }

    return queries
}