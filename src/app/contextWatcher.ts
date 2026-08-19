/**
 * ContextWatcher module — Step 9 of the memory architecture.
 *
 * The SECOND background process. While the MemoryScheduler (Step 3) persists
 * long-term memories every 3 minutes, the ContextWatcher keeps a live view of
 * the CURRENT conversation topic from the short-term messageHistory:
 *
 *   messageHistory -> ContextWatcher -> current topic
 *                                         |
 *                                         v
 *                              (neo4j lookup, Step 10)
 *                                         |
 *                                         v
 *                                relevant knowledge (Step 11)
 *
 * Topic detection is pluggable via a TopicAnalyzer (a deterministic rule-based
 * default is provided; an LLM analyzer can be injected). When the topic
 * changes, listeners are notified and an optional KnowledgeRetriever (Step 10)
 * is invoked to pull relevant knowledge, which is exposed via
 * getRelevantKnowledge() for the running context (Step 11).
 */

import type { IMessage, IMemory } from './memory.js'
import { MemoryProcessor } from './memoryProcessor.js'
import { entityKey } from './graphSchema.js'

/** Default poll interval for the context watcher (30 seconds). */
export const CONTEXT_POLL_MS = 30 * 1000
/** How many of the most recent messages the watcher considers. */
export const DEFAULT_LOOKBACK = 20

export interface ICurrentTopic {
    /** Human-readable display of the topic (original casing). */
    topic: string
    /** entityKey(topic) — used for Entity.name graph lookup in Step 10. */
    key: string
    /** Recent user messages that produced this topic. */
    evidence: string[]
    /** ISO timestamp of when the topic was computed. */
    observedAt: string
}

/** Turns recent messages into a current-topic snapshot. */
export type TopicAnalyzer = (recentMessages: readonly IMessage[]) => ICurrentTopic

/** Notified whenever the current topic changes. */
export type TopicListener = (topic: ICurrentTopic) => void

/**
 * Step 10 seam: given the current topic, retrieve relevant knowledge (from
 * Neo4j). Returns data that is surfaced via getRelevantKnowledge().
 */
export type KnowledgeRetriever = (
    topic: ICurrentTopic,
    processor: MemoryProcessor,
) => Promise<unknown>

export interface IContextWatcherOptions {
    /** The short-term conversation memory to watch. */
    memory: IMemory
    /** Topic detection. Defaults to the rule-based defaultTopicAnalyzer. */
    analyzer?: TopicAnalyzer
    /** Optional knowledge lookup (Step 10). */
    retriever?: KnowledgeRetriever
    /** Poll interval in ms. Defaults to CONTEXT_POLL_MS. */
    intervalMs?: number
    /** How many recent messages to consider. Defaults to DEFAULT_LOOKBACK. */
    lookback?: number
    /** Run an immediate tick on start(). Defaults to false. */
    runImmediately?: boolean
}

/** Common words unlikely to be a topic. */
const STOPWORDS = new Set([
    'i', 'me', 'my', 'you', 'your', 'we', 'our', 'us', 'a', 'an', 'the', 'and',
    'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'with', 'from', 'by',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
    'that', 'these', 'those', 'can', 'could', 'would', 'should', 'will', 'do',
    'does', 'did', 'have', 'has', 'had', 'want', 'wants', 'like', 'likes',
    'love', 'loves', 'prefer', 'prefers', 'enjoy', 'enjoys', 'moving', 'move',
    'moved', 'relocating', 'relocate', 'about', 'what', 'how', 'why', 'when',
    'where', 'who', 'which', 'please', 'help', 'need', 'get', 'got', 'give',
    'tell', 'there', 'here', 'over', 'than', 'into', 'onto', 'not', 'no',
])

/**
 * Deterministic, network-free topic detection: tokenize recent user messages,
 * drop stopwords, and pick the token with the highest frequency, breaking ties
 * by longer (more specific) words. The result's `key` is the entityKey used
 * for Step-10 graph lookup.
 */
export function defaultTopicAnalyzer(recentMessages: readonly IMessage[]): ICurrentTopic {
    const userMessages = recentMessages
        .filter(message => message.role === 'user')
        .slice(-3)
    const evidence = userMessages.map(message => message.content)
    const observedAt = new Date().toISOString()

    const scores = new Map<string, number>()
    for (const message of userMessages) {
        const tokens = message.content.toLowerCase().match(/[a-z0-9]+/g) ?? []
        for (const token of tokens) {
            if (token.length < 3 || /\d/.test(token) || STOPWORDS.has(token)) continue
            scores.set(token, (scores.get(token) ?? 0) + 1)
        }
    }

    let bestToken = ''
    let bestCount = 0
    let bestLength = 0
    for (const [token, count] of scores) {
        if (count > bestCount || (count === bestCount && token.length > bestLength)) {
            bestToken = token
            bestCount = count
            bestLength = token.length
        }
    }

    return { topic: bestToken, key: entityKey(bestToken), evidence, observedAt }
}

export class ContextWatcher {
    private readonly memory: IMemory
    private readonly processor: MemoryProcessor
    private readonly analyzer: TopicAnalyzer
    private readonly retriever: KnowledgeRetriever | undefined
    private readonly intervalMs: number
    private readonly lookback: number
    private readonly runImmediately: boolean
    private readonly listeners: TopicListener[] = []

    private timer: ReturnType<typeof setInterval> | null = null
    private currentTopic: ICurrentTopic | null = null
    private relevantKnowledge: unknown = null
    private running = false

    constructor(options: IContextWatcherOptions) {
        this.memory = options.memory
        this.processor = new MemoryProcessor(options.memory)
        this.analyzer = options.analyzer ?? defaultTopicAnalyzer
        this.retriever = options.retriever
        this.intervalMs = options.intervalMs ?? CONTEXT_POLL_MS
        this.lookback = options.lookback ?? DEFAULT_LOOKBACK
        this.runImmediately = options.runImmediately ?? false

        if (this.intervalMs <= 0) {
            throw new Error('ContextWatcher: intervalMs must be a positive number')
        }
    }

    /** Whether the watcher's poll loop is running. */
    public get isRunning(): boolean {
        return this.timer !== null
    }

    /** The short-term memory being watched. */
    public getMemory(): IMemory {
        return this.memory
    }

    /** Processor bound to the watched memory. */
    public getProcessor(): MemoryProcessor {
        return this.processor
    }

    /** The current topic, or null before the first tick. */
    public getCurrentTopic(): ICurrentTopic | null {
        return this.currentTopic
    }

    /** Relevant knowledge fetched for the current topic (Step 10/11). */
    public getRelevantKnowledge(): unknown {
        return this.relevantKnowledge
    }

    /** Be notified whenever the current topic changes. Returns an unsubscribe. */
    public subscribe(listener: TopicListener): () => void {
        this.listeners.push(listener)
        return () => {
            const index = this.listeners.indexOf(listener)
            if (index !== -1) this.listeners.splice(index, 1)
        }
    }

    /** Start the poll loop. Safe to call multiple times. */
    public start(): ContextWatcher {
        if (this.isRunning) return this
        this.timer = setInterval(() => {
            void this.tick()
        }, this.intervalMs)
        if (this.runImmediately) {
            void this.tick()
        }
        return this
    }

    /** Stop the poll loop. In-flight ticks are left to finish. */
    public stop(): ContextWatcher {
        if (this.timer !== null) {
            clearInterval(this.timer)
            this.timer = null
        }
        return this
    }

    /** Stop watching and clear all topic-change listeners. */
    public dispose(): void {
        this.stop()
        this.listeners.length = 0
    }

    /**
     * Recompute the current topic from the recent history. When it changes,
     * listeners are notified and the optional retriever (Step 10) is invoked.
     */
    public async tick(): Promise<void> {
        if (this.running || this.memory.length === 0) return
        this.running = true
        try {
            const recent = this.memory.getMessages().slice(-this.lookback)
            const topic = this.analyzer(recent)
            const changed = !this.currentTopic || this.currentTopic.key !== topic.key

            if (changed) {
                this.currentTopic = topic
                this.notify(topic)
                if (this.retriever && topic.key) {
                    this.relevantKnowledge = await this.retriever(topic, this.processor)
                } else {
                    this.relevantKnowledge = null
                }
            }
        } finally {
            this.running = false
        }
    }

    private notify(topic: ICurrentTopic): void {
        for (const listener of this.listeners) {
            listener(topic)
        }
    }
}