# Neo4j Graph Schema — Personal Agent long-term memory (Step 5)

Source of truth: `src/app/graphSchema.ts`.

## Purpose
Long-term memory is stored as a property graph. Every 3 minutes the
MemoryScheduler extracts structured memory (`summary`, `facts`, `relations`,
`feedback`) from new conversation, and that record is written into this graph
by the insertion step (Step 8).

## Nodes

| Label      | Purpose                              | Key property            | Unique on |
|------------|--------------------------------------|-------------------------|-----------|
| `Entity`   | Named things: user, places, concepts | `name` (via `entityKey`) | `name`    |
| `Fact`     | Atomic, durable factual statement    | `text`                  | `text`    |
| `Summary`  | One summary per extracted segment    | `summaryId`             | —         |
| `Feedback` | User feedback signal                 | `feedbackId`            | —         |

Common properties: `extractedAt` (ISO), `extractionId` (provenance back to the
`IMemoryExtraction` that produced it), optional `confidence`.

`Entity.type` is one of `person | place | organization | concept | other`.

## Relationships

```
(:Entity)-[:RELATES_TO {predicate, confidence?, extractedAt, extractionId}]->(:Entity)
(:Fact)-[:ABOUT {extractedAt, extractionId}]->(:Entity)
(:Summary)-[:ABOUT {extractedAt, extractionId}]->(:Entity)
(:Feedback)-[:ABOUT {extractedAt, extractionId}]->(:Entity)
```

- `RELATES_TO` carries the (Step-6 normalized) canonical predicate between two
  entities, e.g. `(User)-[:RELATES_TO {predicate:"PREFERS"}]->(coffee)`. Raw
  predicates that match no normalization rule keep their cleaned form.
- `ABOUT` connects every memory item to the entities it mentions, enabling
  entity-centric retrieval (context watcher, Steps 9–10).

## Key derivation

`entityKey(name)` = `trim().toLowerCase().collapseWhitespace()`.
`"User"`, `"user "`, `"  USER"` all become the unique key `user`. The display
label keeps the original casing.

## Constraints & indexes (`SCHEMA_DDL`, idempotent)

```cypher
CREATE CONSTRAINT entity_name_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE;
CREATE CONSTRAINT fact_text_unique IF NOT EXISTS FOR (f:Fact) REQUIRE f.text IS UNIQUE;
CREATE INDEX entity_type_idx IF NOT EXISTS FOR (e:Entity) ON (e.type);
CREATE INDEX fact_extracted_at_idx IF NOT EXISTS FOR (f:Fact) ON (f.extractedAt);
CREATE INDEX summary_extracted_at_idx IF NOT EXISTS FOR (s:Summary) ON (s.extractedAt);
CREATE FULLTEXT INDEX fact_text_ft IF NOT EXISTS FOR (f:Fact) ON EACH [f.text];
CREATE INDEX relates_predicate_idx IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON (r.predicate);
```

## Dedup strategy (used by Step 8)

- Entities: `MERGE` on `name`.
- Facts: `MERGE` on `text`.
- Relations: `MERGE` on (subject key, predicate, object key).
