import { log } from "node:console"
import { HARNESS_PROMPTS } from "./config.js"
import { Memory } from "./memory.js"
import { MemoryProcessor } from "./memoryProcessor.js"
import { MemoryScheduler } from "./memoryScheduler.js"
import type { IMemorySchedulerOptions } from "./memoryScheduler.js"
import { ContextWatcher, defaultTopicAnalyzer } from "./contextWatcher.js"
import type { ICurrentTopic, TopicAnalyzer, KnowledgeRetriever } from "./contextWatcher.js"
import { buildRunningContext } from "./runningContext.js"
import type { IRunningContext } from "./runningContext.js"
import type { IRelevantKnowledge } from "./graphRetrieval.js"
import { createGraphKnowledgeRetriever } from "./graphRetrieval.js"
import { normalizeRelations } from "./graphNormalization.js"
import type { INormalizedRelation } from "./graphNormalization.js"
import type { IRetrievedRelation } from "./graphRetrieval.js"
import { Neo4jMemoryStore } from "./graphStore.js"
import { detectConflicts } from "./conflictDetector.js"
import { decideFeedback } from "./feedbackEngine.js"
import type { IConflictAnalysis, IConflictFinding } from "./conflictDetector.js"
import type { IFeedback } from "./feedbackEngine.js"
import { MemoryExtractor } from "./memoryExtraction.js"
import type { IMessage, IMemory, MessageListener } from "./memory.js"
import type { IMemoryExtraction, IMemoryExtractor } from "./memoryExtraction.js"
import Openai from 'openai'
import "dotenv/config"

export type { IMessage, IMemory, MessageListener } from './memory.js'
export type { IMemoryExtraction, IMemoryExtractor, IExtractedRelation, IExtractedFeedback, ExtractionFeedbackType } from './memoryExtraction.js'

export interface ITool {
    name: string
    description: string
    doc?: string
    executor: (input: string) => Promise<string>
}

/** Alias kept for code subscribing to conversation messages. */
export type Interceptor = MessageListener

/** LLM message shape passed to the responder (role + content only). */
export interface ILlmMessage {
    role: string
    content: string
}

/**
 * Pluggable LLM seam. When set on the builder, `Agent.run()` uses this instead
 * of the built-in OpenAI client — letting tests assert exactly what the LLM
 * receives (e.g. that the running context with "ravi LIKES coffee" is inside
 * the system prompt) and drive the response steps deterministically.
 */
export type AgentResponder = (messages: readonly ILlmMessage[]) => Promise<string | null>

export class AgentBuilder {
    public instructions: string | undefined
    public toolList: ITool[]
    public memory: IMemory | undefined
    public memoryExtractor: IMemoryExtractor | undefined
    public memoryStore: Neo4jMemoryStore | undefined
    public topicAnalyzer: TopicAnalyzer | undefined
    public knowledgeRetriever: KnowledgeRetriever | undefined
    public responder: AgentResponder | undefined

    constructor() {
        this.toolList = []
    }

    public setInstructions(instructions: string) {
        this.instructions = instructions
        return this
    }

    public tool(t: ITool) {
        this.toolList.push(t)
        return this
    }

    /** Inject a custom memory / conversation-history store. */
    public withMemory(memory: IMemory) {
        this.memory = memory
        return this
    }

    /**
     * Inject a custom memory extractor (Step 4: summary / facts / relations /
     * feedback). If omitted, a default OpenAI-backed extractor is created when
     * OPENAI_API_KEY is present.
     */
    public withMemoryExtractor(extractor: IMemoryExtractor) {
        this.memoryExtractor = extractor
        return this
    }

    /**
     * Inject the Neo4j graph store (Steps 7-8). When set, every extraction
     * produced by the background scheduler is also written to the graph.
     */
    public withMemoryStore(store: Neo4jMemoryStore) {
        this.memoryStore = store
        return this
    }

    /**
     * Inject a custom topic detector for the context watcher (Step 9).
     * Defaults to the rule-based defaultTopicAnalyzer.
     */
    public withTopicAnalyzer(analyzer: TopicAnalyzer) {
        this.topicAnalyzer = analyzer
        return this
    }

    /**
     * Inject a custom knowledge retriever for the context watcher (Step 10).
     * When not set, a Neo4j-backed retriever is created automatically if a
     * memory store is configured.
     */
    public withKnowledgeRetriever(retriever: KnowledgeRetriever) {
        this.knowledgeRetriever = retriever
        return this
    }

    /**
     * Inject a custom LLM responder (test seam). When set, Agent.run() calls
     * this instead of the OpenAI client — used by actual-agent tests to prove
     * the running context (latest graph state) is injected into the system
     * prompt and to drive deterministic response steps.
     */
    public withResponder(responder: AgentResponder) {
        this.responder = responder
        return this
    }

    public build() {
        return new Agent(this)
    }
}

export class Agent {
    private readonly instructions: string
    private readonly memory: IMemory
    private readonly memoryProcessor: MemoryProcessor
    private memoryScheduler: MemoryScheduler | undefined
    private contextWatcher: ContextWatcher | undefined
    private readonly memoryExtractor: IMemoryExtractor | undefined
    private readonly memoryStore: Neo4jMemoryStore | undefined
    private readonly topicAnalyzer: TopicAnalyzer | undefined
    private readonly knowledgeRetriever: KnowledgeRetriever | undefined
    private readonly responder: AgentResponder | undefined
    private readonly memoryExtractions: IMemoryExtraction[] = []
    private readonly openai: Openai
    public readonly toolMap: Map<string, ITool>

    public MAX_LOOP = 30

    constructor(builder: AgentBuilder) {
        this.toolMap = new Map()
        this.openai = new Openai({
            apiKey: process.env.OPENAI_API_KEY
        })

        for (const t of builder.toolList) {
            this.toolMap.set(t.name, t)
        }

        this.instructions = ` ${HARNESS_PROMPTS}\n\n
        System prompt: ${builder.instructions}

        AvailableTools : 
        ${builder.toolList.map(t => JSON.stringify({ functionName: t.name, functionDesc: t.description, functionDoc: t.doc })).join('\n')}
               
        `

        // The agent owns the conversation memory. By default an in-memory
        // store is used; a custom one can be injected via AgentBuilder.withMemory().
        this.memory = builder.memory ?? new Memory()

        // A processor that reads / analyses the agent's conversation history.
        this.memoryProcessor = new MemoryProcessor(this.memory)

        // A memory extractor (Step 4). Defaults to an OpenAI-backed extractor
        // when an API key is configured, so the 3-minute scheduler can run
        // extraction automatically; otherwise extraction is skipped.
        this.memoryExtractor = builder.memoryExtractor ?? this.createDefaultExtractor()

        // Optional Neo4j graph store (Steps 7-8). When set, extractions are
        // also written into the graph.
        this.memoryStore = builder.memoryStore

        // Optional custom topic detector for the context watcher (Step 9).
        this.topicAnalyzer = builder.topicAnalyzer

        // Optional custom graph retriever (Step 10); falls back to a
        // store-backed retriever when no custom one is provided.
        this.knowledgeRetriever = builder.knowledgeRetriever

        // Optional custom LLM responder (test seam); falls back to OpenAI.
        this.responder = builder.responder
    }

    /** The memory / conversation-history backing this agent. */
    public getMemory(): IMemory {
        return this.memory
    }

    /** A processor for reading / analysing the agent's conversation history. */
    public getMemoryProcessor(): MemoryProcessor {
        return this.memoryProcessor
    }

    /**
     * The agent's background scheduler (created lazily). Every 3 minutes it
     * runs the memory extractor over newly accumulated messages and records
     * the resulting extraction records (Step 4). If no extractor is available,
     * no processing occurs.
     */
    public getMemoryScheduler(): MemoryScheduler {
        if (!this.memoryScheduler) {
            const extractor = this.memoryExtractor
            const options: IMemorySchedulerOptions = extractor
                ? { memory: this.memory, task: (batch) => this.runExtraction(batch, extractor) }
                : { memory: this.memory }
            this.memoryScheduler = new MemoryScheduler(options)
        }
        return this.memoryScheduler
    }

    /**
     * The structured extraction records produced so far by the background
     * scheduler (summary / facts / relations / feedback). Empty until the
     * scheduler runs.
     */
    public getMemoryExtractions(): readonly IMemoryExtraction[] {
        return this.memoryExtractions
    }

    /** The most recent extraction record, or undefined until the scheduler runs. */
    public get lastExtraction(): IMemoryExtraction | undefined {
        return this.memoryExtractions[this.memoryExtractions.length - 1]
    }

    /**
     * The agent's context watcher (Step 9, created lazily). A second background
     * process that keeps a live view of the current conversation topic. Call
     * .start() to begin polling; topic changes notify subscribers and (when a
     * retriever is attached, Step 10) refresh relevant knowledge.
     */
    public getContextWatcher(): ContextWatcher {
        if (!this.contextWatcher) {
            const store = this.memoryStore
            const retriever = this.knowledgeRetriever
                ?? (store ? createGraphKnowledgeRetriever(store) : undefined)

            const options = retriever
                ? {
                    memory: this.memory,
                    analyzer: this.topicAnalyzer ?? defaultTopicAnalyzer,
                    retriever,
                }
                : {
                    memory: this.memory,
                    analyzer: this.topicAnalyzer ?? defaultTopicAnalyzer,
                }
            this.contextWatcher = new ContextWatcher(options)
        }
        return this.contextWatcher
    }

    /**
     * Step 11: resolve the retriever used for the running context. Prefers an
     * injected custom retriever, then the Neo4j-backed one when a store exists.
     */
    private resolveKnowledgeRetriever(): KnowledgeRetriever | undefined {
        if (this.knowledgeRetriever) return this.knowledgeRetriever
        return this.memoryStore ? createGraphKnowledgeRetriever(this.memoryStore) : undefined
    }

    /**
     * Step 11: assemble the running context — relevant graph knowledge for the
     * current topic, formatted for injection into the next LLM call. Returns
     * null when no retriever is configured, so this is safe to call with no
     * graph store wired up.
     */
    public async buildRunningContext(): Promise<IRunningContext | null> {
        const retriever = this.resolveKnowledgeRetriever()
        if (!retriever) return null

        const topic = this.detectCurrentTopic()
        if (!topic.key) return null

        const knowledge = (await retriever(topic, this.memoryProcessor)) as IRelevantKnowledge | null
        const running = buildRunningContext(topic, knowledge)
        if (!running) return null

        // Step 12: append any conflict-feedback decisions about the latest
        // extraction to the running context block so the next LLM call can
        // respond appropriately.
        const latestExtraction = this.lastExtraction
        if (latestExtraction) {
            const feedback = await this.analyzeConversationFeedback(latestExtraction)
            if (feedback && feedback.length > 0) {
                const sections = feedback.map(fb => `- ${fb.context} (reason: ${fb.reason})`)
                running.text += `\n\n[Conflict feedback]\n${sections.join('\n')}`
            }
        }

        return running
    }

    /**
     * Step 12 — feedback detection against the graph.
     *
     * Runs the ConflictDetector on the given extraction's normalized relations
     * vs the relations currently in the graph (retrieved for the same subject),
     * then runs the FeedbackEngine on each conflict so the running context can
     * tell the LLM how to act. No graph mutation happens here.
     *
     * @returns the feedback decisions, or null when no graph store/retriever is
     * configured — so this is optional and safe to call with no Neo4j.
     */
    public async analyzeConversationFeedback(
        extraction: IMemoryExtraction,
    ): Promise<readonly IFeedback[] | null> {
        const retriever = this.resolveKnowledgeRetriever()
        if (!retriever) return null

        const relations = normalizeRelations(extraction.relations)
        if (relations.length === 0) return []

        const analysis = await this.detectConflictsAgainstGraph(relations, extraction)
        if (!analysis || !analysis.conflict) return []

        return analysis.findings.map(f => decideFeedback(f))
    }

    /** Step 12: build the conflict model for the given relations against the graph. */
    private async detectConflictsAgainstGraph(
        current: readonly INormalizedRelation[],
        extraction: IMemoryExtraction,
    ): Promise<IConflictAnalysis | null> {
        const retriever = this.resolveKnowledgeRetriever()
        if (!retriever) return null

        // Gather the graph relations for every subject involved in the current
        // extraction (so we compare like-for-like).
        const historicalById: Record<string, IRetrievedRelation[]> = {}
        for (const rel of current) {
            const topic: ICurrentTopic = {
                key: rel.subject,
                topic: rel.subject,
                evidence: [],
                observedAt: new Date().toISOString(),
            }
            const knowledge = (await retriever(topic, this.memoryProcessor)) as IRelevantKnowledge | null
            if (knowledge) {
                historicalById[rel.subject] = (historicalById[rel.subject] ?? []).concat(knowledge.relations)
            }
        }

        const historical = Object.values(historicalById).flat()
        const evidence = [...extraction.facts, ...extraction.summary]

        return detectConflicts({ current, historical, evidence })
    }

    private async runExtraction(batch: readonly IMessage[], extractor: IMemoryExtractor): Promise<void> {
        const extraction = await extractor.extract(batch)
        this.memoryExtractions.push(extraction)
        if (this.memoryStore) {
            await this.memoryStore.saveExtraction(extraction)
        }
    }

    /**
     * A default extractor backed by the agent's OpenAI client. Returns
     * undefined when no API key is configured so the scheduler stays a no-op.
     */
    private createDefaultExtractor(): IMemoryExtractor | undefined {
        if (!process.env.OPENAI_API_KEY) return undefined
        return new MemoryExtractor(async (prompt) => {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' },
            })
            return response.choices[0]?.message.content ?? null
        })
    }

    /** Observe every new message appended to the conversation memory. */
    public attachInterceptor(interceptor: Interceptor): () => void {
        return this.memory.subscribe(interceptor)
    }

    static builder() {
        return new AgentBuilder()
    }

    public printSystemPrompt() {
        console.log(this.instructions)
    }

    public async run(query: string): Promise<readonly IMessage[] | undefined> {
        // Record the user query in the conversation memory.
        this.memory.addUser(query)

        // Step 11: pull relevant graph knowledge for the current topic and make
        // it part of the "running context" of the next LLM call. Guarded so a
        // graph store outage never breaks the conversation.
        let runningContext: string | null = null
        try {
            const context = await this.buildRunningContext()
            runningContext = context ? context.text : null
        } catch {
            runningContext = null
        }

        

        for (let i = 0; i < this.MAX_LOOP; i++) {
            const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'developer'; content: string }> = [
                { role: 'system', content: this.instructions },
            ]

            // Relevant graph knowledge (Step 11) only when something was retrieved.
            if (runningContext) {
                messages.push({ role: 'developer', content: runningContext })
            }

            // Full short-term message history.
            messages.push(
                ...this.memory.getMessages().map(e => ({ role: e.role, content: e.content })),
            )

            const llmResponse = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages,
            })

            const rawLLMResponse: string | null = llmResponse.choices[0]?.message.content ?? null

            // Remember the assistant message.
            if (rawLLMResponse === null) break
            this.memory.addAssistant(rawLLMResponse)

            // Parse the Raw LLM Response to JSON Object.
            const parsedResult = JSON.parse(rawLLMResponse)

            // OUTPUT step => stop condition, return the full conversation history.
            if (parsedResult.step.toLowerCase() === "output") return this.memory.getMessages()

            // TOOL_REQUEST step => locate the tool, execute it and remember the result.
            if (parsedResult.step.toLowerCase() === 'tool_request') {
                const { functionName, input } = parsedResult
                const tool = this.toolMap.get(functionName)

                if (!tool) {
                    this.memory.addDeveloper(`Error : Function with name ${functionName} does not exits`)
                    continue
                }

                const toolResult = await tool.executor(input)
                this.memory.addDeveloper(JSON.stringify({
                    functionName,
                    input,
                    toolResult
                }))
            }
        }
    }
}