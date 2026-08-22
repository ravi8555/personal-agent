/**
 * BackgroundMemoryProcessor module — orchestration of all the pieces.
 *
 * Architectural decisions (recorded here so they stay in code):
 *
 *   1. This processor lives BELOW the agent layer. It NEVER calls Agent.run()
 *      and never generates assistant responses. The Agent responds to the user
 *      and reads the running context; the processor keeps long-term memory
 *      fresh in the background. Both share the same memory/graph components.
 *
 *   2. The 3-minute timer is NOT inside this class. {@link BackgroundScheduler}
 *      owns the interval and simply calls {@link process} — so tests can run
 *      `await processor.process()` without waiting three minutes.
 *
 *   3. Only new history is processed (watermark, see Point 9). The processor
 *      tracks `lastProcessedMessageId`/`lastProcessedAt` and only consumes
 *      messages added after the watermark. In-memory for this first
 *      implementation; move to Neo4j/Postgres for multi-instance later.
 *
 *   4. Overlapping executions are prevented (Point 10): the `running` guard
 *      skips a tick if the previous one is still in flight, so a slow pipeline
 *      (e.g. 4 minutes) never runs twice in parallel.
 *
 *   5. The running context stays REQUEST-TIME (Point 7). This background
 *      processor persists knowledge/feedback/self-correction to the graph and
 *      keeps the latest extraction/feedback/correction state available via
 *      getters, but it does NOT assemble the request-time context. The Agent
 *      builds the running context fresh when it is about to answer, so the LLM
 *      always receives the latest corrected state (feedback persisted in the
 *      background, Point 8).
 *
 * Pipeline (process):
 *   1. read new history (only messages after the watermark)
 *   2. extract knowledge (summary / facts / relations / feedback)
 *   3. normalize relations
 *   4. write knowledge to Neo4j (graph upsert)
 *   5. determine current topic (ContextWatcher)
 *   6. retrieve historical knowledge (GraphKnowledgeRetriever)
 *   7. detect conflicts (ConflictDetector)
 *   8. generate feedback (FeedbackEngine)
 *   9. self-correct the graph (SelfCorrectionEngine)
 *  10. persist latest state for request-time running context
 */

import type { IMemory, IMessage } from './memory.js'
import type { IMemoryExtractor, IMemoryExtraction } from './memoryExtraction.js'
import { normalizeRelations, type INormalizedRelation } from './graphNormalization.js'
import type { Neo4jMemoryStore } from './graphStore.js'
import type { ContextWatcher, KnowledgeRetriever, ICurrentTopic } from './contextWatcher.js'
import { createGraphKnowledgeRetriever, type IRelevantKnowledge, type IRetrievedRelation } from './graphRetrieval.js'
import { detectConflicts } from './conflictDetector.js'
import { decideFeedback, type IFeedback } from './feedbackEngine.js'
import { createSelfCorrectionEngine, type SelfCorrectionEngine, type ISelfCorrectionReport } from './selfCorrection.js'

/** Watermark/processing state (Point 9) — in-memory for now. */
export interface IMemoryProcessingState {
    /** Message id of the last message that was processed (message-123). */
    lastProcessedMessageId: string | null
    /** ISO timestamp of the last completed processing cycle. */
    lastProcessedAt: string | null
}

export interface IBackgroundMemoryProcessorOptions {
    /** The short-term conversation memory to watch. */
    memory: IMemory
    /** Step-4 structured extractor (summary / facts / relations / feedback). */
    extractor: IMemoryExtractor
    /** Step-8 Neo4j store — writes (upsert) and later reads corrections. */
    store: Neo4jMemoryStore
    /** Step-9 context watcher — current topic + relevant knowledge. */
    watcher: ContextWatcher
    /** Step-10 retriever. Defaults to a store-backed GraphKnowledgeRetriever. */
    retriever?: KnowledgeRetriever
    /** Step-13 self-correction engine. Defaults to a store-backed engine. */
    selfCorrection?: SelfCorrectionEngine
    /** Initial processing state (watermark). Defaults to a fresh state. */
    state?: IMemoryProcessingState
}

export class BackgroundMemoryProcessor {
    private readonly memory: IMemory
    private readonly extractor: IMemoryExtractor
    private readonly store: Neo4jMemoryStore
    private readonly watcher: ContextWatcher
    private readonly retriever: KnowledgeRetriever
    private readonly selfCorrection: SelfCorrectionEngine

    private readonly state: IMemoryProcessingState
    private running = false

    private latestExtraction: IMemoryExtraction | null = null
    private latestFeedback: readonly IFeedback[] = []
    private latestCorrections: ISelfCorrectionReport | null = null

    constructor(options: IBackgroundMemoryProcessorOptions) {
        this.memory = options.memory
        this.extractor = options.extractor
        this.store = options.store
        this.watcher = options.watcher
        this.retriever = options.retriever ?? createGraphKnowledgeRetriever(options.store)
        this.selfCorrection = options.selfCorrection ?? createSelfCorrectionEngine(options.store)
        this.state = options.state
            ? { ...options.state }
            : { lastProcessedMessageId: null, lastProcessedAt: null }
    }

    

    /** Whether a processing cycle is currently in flight. */
    public get isRunning(): boolean {
        return this.running
    }

    /** Snapshot of the watermark/processing state. */
    public getProcessingState(): IMemoryProcessingState {
        return { ...this.state }
    }

    /** Latest extraction record (for request-time diagnostics / tests). */
    public getLatestExtraction(): IMemoryExtraction | null {
        return this.latestExtraction
    }

    /** Latest feedback decisions from the last cycle (persisted to graph via corrections). */
    public getLatestFeedback(): readonly IFeedback[] {
        return this.latestFeedback
    }

    /** Latest self-correction report from the last cycle. */
    public getLatestCorrections(): ISelfCorrectionReport | null {
        return this.latestCorrections
    }

    /**
     * Run one full background-processing cycle (the 10-step pipeline).
     * Safe to call directly for testing — no timer involved.
     */
    public async process(): Promise<void> {
        if (this.running) return // Point 10: never overlap (00:00 RUNNING, 03:00 SKIPPED, ...)
        this.running = true
        try {
            // 1. read new history — only messages after the watermark
            const batch = this.readNewMessages()
            if (batch.length === 0) return

            const observedAt = new Date().toISOString()

            // 2. extract knowledge
            const extraction = await this.extractor.extract(batch)

            // 3. normalize relations
            const relations = normalizeRelations(extraction.relations)

            // 4. write knowledge to Neo4j (graph upsert, single transaction)
            await this.store.saveExtraction(extraction)

            // 5. determine current topic
            await this.watcher.tick()
            const topic = this.watcher.getCurrentTopic()

            // 6. retrieve historical knowledge (for the topic + every subject)
            const historical = await this.collectHistoricalRelations(topic, relations)

            // 7. detect conflicts (current extraction vs graph)
            const evidence = [...extraction.facts, ...(extraction.summary ? [extraction.summary] : [])]
            const hasRelations = relations.length > 0
            const analysis = hasRelations
                ? detectConflicts({ current: relations, historical, evidence })
                : { conflict: false, findings: [] as never[] }

            // 8. generate feedback decisions
            const feedback = analysis.conflict
                ? analysis.findings.map(finding => decideFeedback(finding))
                : []

            // 9. self-correct the graph (delete SUPERSEDED edges; keep CONFLICTING)
            let corrections: ISelfCorrectionReport | null = null
            if (analysis.conflict && analysis.findings.length > 0) {
                corrections = await this.selfCorrection.applyCorrections(analysis.findings)
            }

            // 10. persist latest state — request-time running context (Point 7)
            //     reads fresh graph state + these getters when answering.
            this.latestExtraction = extraction
            this.latestFeedback = feedback
            if (corrections) this.latestCorrections = corrections

            // Point 9: advance the watermark only after a successful cycle.
            this.advanceWatermark(batch, observedAt)
        } finally {
            this.running = false
        }
    }

    /** Messages added after the watermark; all messages when it is not set. */
    private readNewMessages(): readonly IMessage[] {
        const messages = this.memory.getMessages()
        if (!this.state.lastProcessedMessageId) return messages

        const index = messages.findIndex(m => m.id === this.state.lastProcessedMessageId)
        // History was cleared/rebuilt since the last run: reprocess everything.
        if (index === -1) return messages
        return messages.slice(index + 1)
    }

    /** Gather historical relations for the topic and for every subject in the batch. */
    private async collectHistoricalRelations(
        topic: ICurrentTopic | null,
        relations: readonly INormalizedRelation[],
    ): Promise<IRetrievedRelation[]> {
        const result: IRetrievedRelation[] = []
        const seen = new Set<string>()
        const push = (relation: IRetrievedRelation) => {
            const key = `${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`
            if (!seen.has(key)) {
                seen.add(key)
                result.push(relation)
            }
        }

        const processor = this.watcher.getProcessor()

        // Relevant knowledge for the current conversation topic.
        if (topic && topic.key) {
            const knowledge = await this.retriever(topic, processor) as IRelevantKnowledge | null
            if (knowledge) {
                for (const relation of knowledge.relations) push(relation)
            }
        }

        // Like-for-like conflict detection: relations for every subject involved.
        for (const relation of relations) {
            const subjectTopic: ICurrentTopic = {
                topic: relation.subject,
                key: relation.subject,
                evidence: [],
                observedAt: new Date().toISOString(),
            }
            const knowledge = await this.retriever(subjectTopic, processor) as IRelevantKnowledge | null
            if (knowledge) {
                for (const historical of knowledge.relations) push(historical)
            }
        }

        return result
    }

    /** Advance the watermark to the latest message in the processed batch. */
    private advanceWatermark(batch: readonly IMessage[], processedAt: string): void {
        const last = batch[batch.length - 1]
        if (!last?.id) return
        this.state.lastProcessedMessageId = last.id
        this.state.lastProcessedAt = processedAt
    }
}