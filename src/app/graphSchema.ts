/**
 * GraphSchema module — Step 5 of the memory architecture.
 *
 * The Neo4j schema that long-term memories are written to and read from.
 *
 * Nodes (labels):
 *   (:Entity)                     named things: the user, places, concepts
 *   (:Fact)                       atomic factual statements worth remembering
 *   (:Summary)                    one summary per extracted conversation segment
 *   (:Feedback)                   user feedback signals (praise/correction/...)
 *
 * Relationships (types):
 *   (:Entity)-[:RELATES_TO {predicate}]->(:Entity)
 *       entity-to-entity triples produced by extraction relations
 *   (:Fact|:Summary|:Feedback)-[:ABOUT]->(:Entity)
 *       every memory item knows which entities it mentions
 *
 * Every node/relationship carries:
 *   extractedAt   — when the extraction ran (ISO)
 *   extractionId  — the IMemoryExtraction record that produced it (provenance)
 *
 * Uniqueness / dedup strategy (used by Step 8 upserts):
 *   - Entity.name   unique, derived via entityKey() (case/whitespace folded)
 *   - Fact.text     unique, so MERGE on text prevents duplicate facts
 *   - RELATES_TO    keyed by (subject key, predicate, object key) — Step 8
 */

import type { ExtractionFeedbackType } from './memoryExtraction.js'

/** Every node label used in the memory graph. */
export const GRAPH_NODE_LABELS = {
    Entity: 'Entity',
    Fact: 'Fact',
    Summary: 'Summary',
    Feedback: 'Feedback',
} as const

export type GraphNodeLabel = (typeof GRAPH_NODE_LABELS)[keyof typeof GRAPH_NODE_LABELS]

/** Every relationship type used in the memory graph. */
export const GRAPH_RELATIONSHIPS = {
    /** Entity -> Entity, carrying a normalized predicate (Step 6). */
    RelatesTo: 'RELATES_TO',
    /** Fact / Summary / Feedback -> Entity. */
    About: 'ABOUT',
} as const

export type GraphRelationshipType =
    (typeof GRAPH_RELATIONSHIPS)[keyof typeof GRAPH_RELATIONSHIPS]

/** Coarse category attached to every entity. */
export type EntityType = 'person' | 'place' | 'organization' | 'concept' | 'other'

export interface IEntityNode {
    /** Unique graph key, derived via entityKey() from the raw name. */
    name: string
    /** Human readable display form of the entity (original casing). */
    label: string
    type: EntityType
    createdAt: string
    updatedAt: string
}

export interface IFactNode {
    factId: string
    /** Atomic statement text; unique in the graph. */
    text: string
    /** Optional model confidence in [0,1]. */
    confidence?: number
    extractedAt: string
    extractionId: string
}

export interface ISummaryNode {
    summaryId: string
    text: string
    extractedAt: string
    extractionId: string
}

export interface IFeedbackNode {
    feedbackId: string
    type: ExtractionFeedbackType
    text: string
    extractedAt: string
    extractionId: string
}

export interface IRelatesToProps {
    /** Canonical predicate; normalization is formalized in Step 6. */
    predicate: string
    /** Optional model confidence in [0,1]. */
    confidence?: number
    extractedAt: string
    extractionId: string
}

export interface IAboutProps {
    extractedAt: string
    extractionId: string
}

/**
 * Fold any entity name into its unique graph key: lowercase, surrounding
 * whitespace removed, internal whitespace collapsed to a single space.
 */
export function entityKey(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * One-time schema DDL: unique constraints + indexes, applied to Neo4j with a
 * Cypher session (executed in Step 8 / migrations). Safe to run repeatedly.
 */
export const FULLTEXT_FACT_INDEX = 'fact_text_ft'

export const SCHEMA_DDL: readonly string[] = [
    // Entity names are unique graph keys.
    `CREATE CONSTRAINT entity_name_unique IF NOT EXISTS FOR (e:${GRAPH_NODE_LABELS.Entity}) REQUIRE e.name IS UNIQUE`,
    // Facts dedupe on their text.
    `CREATE CONSTRAINT fact_text_unique IF NOT EXISTS FOR (f:${GRAPH_NODE_LABELS.Fact}) REQUIRE f.text IS UNIQUE`,
    // Lookups by entity category and fact recency.
    `CREATE INDEX entity_type_idx IF NOT EXISTS FOR (e:${GRAPH_NODE_LABELS.Entity}) ON (e.type)`,
    `CREATE INDEX fact_extracted_at_idx IF NOT EXISTS FOR (f:${GRAPH_NODE_LABELS.Fact}) ON (f.extractedAt)`,
    `CREATE INDEX summary_extracted_at_idx IF NOT EXISTS FOR (s:${GRAPH_NODE_LABELS.Summary}) ON (s.extractedAt)`,
    // Keyword search over fact text (used by the context watcher, Step 9/10).
    `CREATE FULLTEXT INDEX ${FULLTEXT_FACT_INDEX} IF NOT EXISTS FOR (f:${GRAPH_NODE_LABELS.Fact}) ON EACH [f.text]`,
    // Predicate lookups on relation edges.
    `CREATE INDEX relates_predicate_idx IF NOT EXISTS FOR ()-[r:${GRAPH_RELATIONSHIPS.RelatesTo}]-() ON (r.predicate)`,
]
