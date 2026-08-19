/**
 * Neo4jMemoryStore — Step 8 of the memory architecture.
 *
 * Graph insertion / upsert with duplicate prevention.
 *
 *   - initialize(): applies the Step-5 SCHEMA_DDL (unique constraints and
 *     indexes) so Neo4j enforces uniqueness at the database level.
 *   - saveExtraction(): normalizes + deduplicates relations, builds the
 *     Step-7 write queries and runs them in ONE write transaction.
 *   - Duplicate prevention is layered:
 *       1. normalizeRelations() drops unusable relations
 *       2. deduplicateRelations() removes exact duplicates within a batch
 *       3. MERGE + unique constraints (Entity.name, Fact.text, and the
 *          (subject, predicate, object) edge key) prevent duplicates in the DB
 *
 * Accepts a real neo4j-driver configuration, or an injected IGraphDriver so
 * the store can be unit-tested without a running Neo4j server.
 */

import type { IMemoryExtraction } from './memoryExtraction.js'
import { SCHEMA_DDL } from './graphSchema.js'
import { normalizeRelations } from './graphNormalization.js'
import { buildWriteQueries, type IGraphWriteQuery } from './graphCypher.js'
import neo4j from 'neo4j-driver'

export interface IGraphTransaction {
    run(query: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface IGraphSession {
    run(query: string, params?: Record<string, unknown>): Promise<unknown>
    executeWrite(work: (tx: IGraphTransaction) => Promise<unknown>): Promise<unknown>
    close(): Promise<void>
}

export interface IGraphDriver {
    session(config?: { database?: string }): IGraphSession
    close(): Promise<void>
}

export interface INeo4jConfig {
    uri: string
    user: string
    password: string
    database?: string
}

/** Either real connection config, or an injected fake driver for tests. */
export type Neo4jStoreSource = INeo4jConfig | { driver: IGraphDriver }

export class Neo4jMemoryStore {
    private readonly driver: IGraphDriver
    private readonly database: string | undefined

    constructor(source: Neo4jStoreSource) {
        if ('driver' in source) {
            this.driver = source.driver
            this.database = undefined
        } else {
            this.driver = neo4j.driver(
                source.uri,
                neo4j.auth.basic(source.user, source.password),
            ) as unknown as IGraphDriver
            this.database = source.database
        }
    }

    private makeSession(): IGraphSession {
        return this.driver.session(this.database ? { database: this.database } : undefined)
    }

    /**
     * Apply the schema DDL (unique constraints + indexes). Schema statements
     * must run as auto-commit queries, so each one uses its own session.run.
     */
    public async initialize(): Promise<void> {
        const session = this.makeSession()
        try {
            for (const statement of SCHEMA_DDL) {
                await session.run(statement)
            }
        } finally {
            await session.close()
        }
    }

    /** Save one extraction record into the graph in a single write transaction. */
    public async saveExtraction(extraction: IMemoryExtraction): Promise<void> {
        const relations = normalizeRelations(extraction.relations)
        const queries = buildWriteQueries(extraction, relations)
        if (queries.length === 0) return

        const session = this.makeSession()
        try {
            await session.executeWrite(async tx => {
                for (const query of queries) {
                    await tx.run(query.cypher, query.params)
                }
            })
        } finally {
            await session.close()
        }
    }

    /** Run an arbitrary (parameterized) read/write query. Used by later steps. */
    public async runQuery(query: string, params?: Record<string, unknown>): Promise<unknown> {
        const session = this.makeSession()
        try {
            return await session.run(query, params)
        } finally {
            await session.close()
        }
    }

    /** Close the underlying driver. */
    public async close(): Promise<void> {
        await this.driver.close()
    }
}