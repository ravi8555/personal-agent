/**
 * GraphRetrieval module — Step 10 of the memory architecture.
 *
 * Targeted retrieval of relevant knowledge for the CURRENT conversation topic.
 * The ContextWatcher (Step 9) derives the current topic; this module queries
 * the Neo4j graph for everything that is relevant to that topic:
 *
 *   - the matching Entity node (by unique key)
 *   - DIRECT relations: (topic)-[:RELATES_TO]->(x) and (x)-[:RELATES_TO]->(topic)
 *   - Facts / Feedback / Summaries that are -[:ABOUT]->(topic)
 *   - full-text fact search on the topic term as a fallback when the entity is
 *     not (yet) in the graph
 *
 * The assembled IRelevantKnowledge is exactly what Step 11 injects into the
 * running agent context.
 */
import neo4j from "neo4j-driver";
import type { ICurrentTopic, KnowledgeRetriever } from './contextWatcher.js'
import {
    FULLTEXT_FACT_INDEX,
    GRAPH_NODE_LABELS,
    GRAPH_RELATIONSHIPS,
} from './graphSchema.js'

/** Minimal shapes of a neo4j-driver result — kept structural for testability. */
export interface IGraphRecord {
    get(field: string): unknown
}

export interface IGraphQueryResult {
    records: readonly IGraphRecord[]
}

/** Anything able to run a parameterized Cypher query (store or a fake). */
export interface IQueryRunner {
    run(query: string, params?: Record<string, unknown>): Promise<IGraphQueryResult>
}

export interface IRetrievedRelation {
    subject: string
    predicate: string
    object: string
    confidence: number | null
}

export interface IRetrievedFact {
    text: string
    extractedAt: string | null
}

export interface IRetrievedFeedback {
    type: string
    text: string
}

export interface IRetrievedSummary {
    text: string
    extractedAt: string | null
}

export interface IRelevantKnowledge {
    /** entityKey(topic) that was looked up. */
    topicKey: string
    /** Human label of the matched entity ('' when not found). */
    topicLabel: string
    /** Whether an Entity node exists for the topic key. */
    entityFound: boolean
    relations: IRetrievedRelation[]
    facts: IRetrievedFact[]
    feedback: IRetrievedFeedback[]
    summaries: IRetrievedSummary[]
}

// Controlled, parameterized retrieval queries (no user data inline).
const ENTITY_QUERY = `MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: $key}) RETURN e.name AS name, e.label AS label`

const OUTBOUND_RELATIONS_QUERY = `MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: $key})-[r:${GRAPH_RELATIONSHIPS.RelatesTo}]->(o:${GRAPH_NODE_LABELS.Entity}) RETURN o.name AS object, r.predicate AS predicate, r.confidence AS confidence`

const INBOUND_RELATIONS_QUERY = `MATCH (i:${GRAPH_NODE_LABELS.Entity})-[r:${GRAPH_RELATIONSHIPS.RelatesTo}]->(e:${GRAPH_NODE_LABELS.Entity} {name: $key}) RETURN i.name AS subject, r.predicate AS predicate, r.confidence AS confidence`

const FACTS_QUERY = `MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: $key})<-[:${GRAPH_RELATIONSHIPS.About}]-(f:${GRAPH_NODE_LABELS.Fact}) RETURN f.text AS text, f.extractedAt AS extractedAt ORDER BY f.extractedAt DESC LIMIT $limitFacts`

const FEEDBACK_QUERY = `MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: $key})<-[:${GRAPH_RELATIONSHIPS.About}]-(fb:${GRAPH_NODE_LABELS.Feedback}) RETURN fb.type AS type, fb.text AS text LIMIT $limitFeedback`

const SUMMARIES_QUERY = `MATCH (e:${GRAPH_NODE_LABELS.Entity} {name: $key})<-[:${GRAPH_RELATIONSHIPS.About}]-(s:${GRAPH_NODE_LABELS.Summary}) RETURN s.text AS text, s.extractedAt AS extractedAt ORDER BY s.extractedAt DESC LIMIT $limitSummaries`

// The index name is a schema constant (never user data) so it is inlined
// safely; the search term itself is always a parameter.
const FULLTEXT_FACTS_QUERY = `CALL db.index.fulltext.queryNodes('${FULLTEXT_FACT_INDEX}', $term) YIELD node, score WHERE node:${GRAPH_NODE_LABELS.Fact} RETURN node.text AS text, node.extractedAt AS extractedAt ORDER BY score DESC LIMIT $limitFacts`

const DEFAULT_LIMITS = {
    limitFacts: neo4j.int(20),
    limitFeedback: neo4j.int(10),
    limitSummaries: neo4j.int(5),
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function asStringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

/** Normalize neo4j integers ({low, high, toNumber()}) or plain numbers/null. */
function asNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'object' && value !== null) {
        const candidate = value as { toNumber?: unknown }
        if (typeof candidate.toNumber === 'function') {
            const n = candidate.toNumber()
            return typeof n === 'number' ? n : null
        }
    }
    return null
}

export class GraphKnowledgeRetriever {
    private readonly runner: IQueryRunner

    constructor(runner: IQueryRunner) {
        this.runner = runner
    }

    /** Fetch everything relevant to the current conversation topic. */
    public async retrieve(topic: ICurrentTopic): Promise<IRelevantKnowledge> {
        const empty: IRelevantKnowledge = {
            topicKey: topic.key,
            topicLabel: '',
            entityFound: false,
            relations: [],
            facts: [],
            feedback: [],
            summaries: [],
        }
        if (!topic.key) return empty

        const entityResult = await this.run(ENTITY_QUERY, { key: topic.key })
        if (entityResult.records.length === 0) {
            // Entity not in the graph yet: fall back to full-text fact search.
            empty.facts = await this.fetchFulltextFacts(topic.topic)
            return empty
        }

        empty.entityFound = true
        empty.topicLabel = asString(entityResult.records[0]?.get('label'))

        empty.relations = await this.fetchRelations(topic.key)
        empty.facts = await this.fetchFacts(topic.key)
        empty.feedback = await this.fetchFeedback(topic.key)
        empty.summaries = await this.fetchSummaries(topic.key)
        return empty
    }

    private async fetchRelations(key: string): Promise<IRetrievedRelation[]> {
        const [outbound, inbound] = await Promise.all([
            this.run(OUTBOUND_RELATIONS_QUERY, { key }),
            this.run(INBOUND_RELATIONS_QUERY, { key }),
        ])
        return [
            ...outbound.records.map(record => ({
                subject: key,
                predicate: asString(record.get('predicate')),
                object: asString(record.get('object')),
                confidence: asNumberOrNull(record.get('confidence')),
            })),
            ...inbound.records.map(record => ({
                subject: asString(record.get('subject')),
                predicate: asString(record.get('predicate')),
                object: key,
                confidence: asNumberOrNull(record.get('confidence')),
            })),
        ]
    }

    private async fetchFacts(key: string): Promise<IRetrievedFact[]> {
        const result = await this.run(FACTS_QUERY, { key, ...DEFAULT_LIMITS })
        return result.records
            .map(record => ({
                text: asString(record.get('text')),
                extractedAt: asStringOrNull(record.get('extractedAt')),
            }))
            .filter(fact => fact.text.length > 0)
    }

    private async fetchFeedback(key: string): Promise<IRetrievedFeedback[]> {
        const result = await this.run(FEEDBACK_QUERY, { key, ...DEFAULT_LIMITS })
        return result.records.map(record => ({
            type: asString(record.get('type')),
            text: asString(record.get('text')),
        }))
    }

    private async fetchSummaries(key: string): Promise<IRetrievedSummary[]> {
        const result = await this.run(SUMMARIES_QUERY, { key, ...DEFAULT_LIMITS })
        return result.records.map(record => ({
            text: asString(record.get('text')),
            extractedAt: asStringOrNull(record.get('extractedAt')),
        }))
    }

    private async fetchFulltextFacts(term: string): Promise<IRetrievedFact[]> {
        if (!term.trim()) return []
        const result = await this.run(FULLTEXT_FACTS_QUERY, { term, ...DEFAULT_LIMITS })
        return result.records
            .map(record => ({
                text: asString(record.get('text')),
                extractedAt: asStringOrNull(record.get('extractedAt')),
            }))
            .filter(fact => fact.text.length > 0)
    }

    private async run(query: string, params: Record<string, unknown>): Promise<IGraphQueryResult> {
        const result = await this.runner.run(query, params)
        return { records: result?.records ?? [] }
    }
}

/**
 * A factory to make a ContextWatcher-compatible KnowledgeRetriever from the
 * Neo4jMemoryStore (or anything whose runQuery returns IGraphQueryResult).
 */
export function createGraphKnowledgeRetriever(
    runner: { runQuery(query: string, params?: Record<string, unknown>): Promise<IGraphQueryResult> },
): KnowledgeRetriever {
    const retriever = new GraphKnowledgeRetriever({ run: (query, params) => runner.runQuery(query, params) })
    return (topic: ICurrentTopic) => retriever.retrieve(topic)
}