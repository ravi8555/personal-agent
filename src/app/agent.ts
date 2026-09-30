import { log } from "node:console"
import { HARNESS_PROMPTS } from "./config.js"
import { detectIntent } from "./intentEngine.js"
import type { IIntentResult, IntentDetector } from "./intentEngine.js"
import { Planner } from "./planner.js"
import { PlanExecutor } from "./planExecutor.js"
import type { IPlanExecutionResult } from "./planExecutor.js"
import { buildDynamicContext } from "./dynamicContext.js"
import { createDefaultToolRegistry, ToolRegistry } from "./toolRegistry.js"
import { createDefaultActionRegistry } from "./action/actionRegistry.js"
import type { ActionRegistry } from "./action/actionRegistry.js"
import { createDefaultToolPolicy } from "./toolPolicy.js"
import type { IToolPolicy } from "./toolPolicy.js"
import type { IPlan, IPlanStep } from "./planTypes.js"
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
    public intentDetector: IntentDetector | undefined
    public planner: Planner | undefined
    public planExecutor: PlanExecutor | undefined
    public toolRegistry: ToolRegistry | undefined
    /** Phase 3 (3.9): permission policy between validator and executor. */
    public toolPolicy: IToolPolicy | undefined
    /** Phase 4A (4.1): internal action engine for kind === "action" steps. */
    public actionRegistry: ActionRegistry | undefined

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

    /**
     * Step 10b seam (Phase 1): inject a custom intent classifier.
     * Defaults to the rule-based `detectIntent` — pure classification,
     * no routing, no side effects.
     */
    public withIntentDetector(detector: IntentDetector) {
        this.intentDetector = detector
        return this
    }

    /** Phase 2: register tools the planner/executor may call (MCP-ready). */
    public withToolRegistry(registry: ToolRegistry) {
        this.toolRegistry = registry
        return this
    }

    /**
     * Phase 3 (3.9): permission policy applied by the PlanExecutor before
     * any tool (local or MCP) executes. Defaults to the read-only-allow /
     * state-change-confirm policy.
     */
    public withToolPolicy(policy: IToolPolicy) {
        this.toolPolicy = policy
        return this
    }

    /** Phase 4A (4.1): inject the internal action engine (defaults to pure built-ins). */
    public withActionRegistry(actions: ActionRegistry) {
        this.actionRegistry = actions
        return this
    }

    /** Phase 2: inject a custom structured planner (LLM or rule-based). */
    public withPlanner(planner: Planner) {
        this.planner = planner
        return this
    }

    /** Phase 2: inject a custom plan executor (tests / custom runtimes). */
    public withPlanExecutor(executor: PlanExecutor) {
        this.planExecutor = executor
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
    private readonly intentDetector: IntentDetector

    /**
     * Latest classification from Step 10b (null until the first `run()`).
     * Phase 1: informational only — Memory → ContextWatcher → Retriever →
     * RunningContext → LLM pipeline is unchanged; tasks are NOT executed.
     */
    private lastIntent: IIntentResult | null = null
    private readonly planner: Planner | undefined
    private readonly planExecutor: PlanExecutor | undefined
    private readonly toolRegistry: ToolRegistry
    /** Phase 3: permission gate applied by the executor before tool calls. */
    private readonly toolPolicy: IToolPolicy
    /** Phase 4A: internal action engine for kind === "action" steps. */
    private readonly actionRegistry: ActionRegistry
    /** Phase 2: last plan + execution result (in-memory, never in Neo4j). */
    private lastPlan: IPlan | null = null
    private lastPlanResult: IPlanExecutionResult | null = null
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
        this.intentDetector = builder.intentDetector ?? detectIntent

        // Phase 2/3/4A: planning engine. Tools come from an injectable registry
        // (local demo tools + MCP tools discovered via src/app/mcp/). The
        // planner's knownTools is fed from registry.listTools() (3.4), so MCP
        // discovery is automatically visible to the LLM planner. The planner
        // prefers an LLM when a key is configured and always falls back to a
        // deterministic rule-based plan otherwise. The executor enforces the
        // permission policy before ANY tool (local or MCP) runs (3.9), and
        // resolves kind === "action" steps through the Action Engine (4.1) —
        // internal capabilities that never touch the registry or the policy.
        this.toolRegistry = builder.toolRegistry ?? createDefaultToolRegistry()
        this.toolPolicy = builder.toolPolicy ?? createDefaultToolPolicy()
        this.actionRegistry = builder.actionRegistry ?? createDefaultActionRegistry()
        const llmPlannerHook = this.createLlmPlannerHook()
        this.planner = builder.planner ?? new Planner({
            // Live getters (3.3/3.4): MCP discovery after build() stays visible.
            knownTools: () => this.toolRegistry.listTools().map(tool => tool.name),
            requiredArgs: () => this.toolRegistry.requiredArgsMap(),
            toolCatalog: () => this.toolRegistry.listTools(),
            // Phase 4B: the LLM planner is explicitly action-aware — live
            // action catalog + allow-list from the ActionRegistry.
            knownActions: () => this.actionRegistry.names(),
            actionCatalog: () => this.actionRegistry.entries(),
            ...(llmPlannerHook ? { generatePlan: llmPlannerHook } : {}),
        })
        this.planExecutor = builder.planExecutor ?? new PlanExecutor(this.toolRegistry, {
            policy: this.toolPolicy,
            actions: this.actionRegistry,
        })
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
     * current topic, formatted for injection into the next LLM call. Routes
     * through the ContextWatcher chain (Agent → ContextWatcher →
     * GraphKnowledgeRetriever → buildRunningContext) so the topic evidence is
     * fresh and the retriever is the watcher's own. Returns null when no
     * retriever is configured, so this is safe to call with no graph store
     * wired up.
     */
    public async buildRunningContext(): Promise<IRunningContext | null> {
        const watcher = this.getContextWatcher()
        const retriever = watcher.getRetriever()
        if (!retriever) return null

        // Refresh the current topic via the watcher (keeps evidence fresh).
        await watcher.tick()
        const topic = watcher.getCurrentTopic()
        if (!topic || !topic.key) return null

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

    /** Latest Step 10b classification (null until the first `run()`). */
    public getLastIntent(): IIntentResult | null {
        return this.lastIntent
    }

    /** Phase 2: last plan produced for a task turn (in-memory only). */
    public getLastPlan(): IPlan | null {
        return this.lastPlan
    }

    /** Phase 2: last plan execution result (in-memory only). */
    public getLastPlanResult(): IPlanExecutionResult | null {
        return this.lastPlanResult
    }

    /** Phase 2: the tool registry backing planner + executor (MCP-ready). */
    public getToolRegistry(): ToolRegistry {
        return this.toolRegistry
    }

    /** Phase 4A: the internal action engine backing kind === "action" steps. */
    public getActionRegistry(): ActionRegistry {
        return this.actionRegistry
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

        // Step 10b: classify the turn (Phase 1 rules, unchanged).
        this.lastIntent = this.intentDetector(query)
        this.lastPlan = null
        this.lastPlanResult = null

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

        // Step 11b (Phase 2): Task intent + confidence >= threshold moves along
        // the planning path: Planner → IPlan → PlanExecutor → Tools → Results.
        // Question/Conversation keep the unchanged retrieval + memory path.
        let planningNote: string | null = null
        if (this.lastIntent.type === "task") {
            planningNote = await this.runTaskPlan(query, this.lastIntent, runningContext)
        }

        // Dynamic context: Memory Engine ("what do I know") + Planning Engine
        // ("what should I do" / "what happened") as labelled sections, so the
        // LLM reports real execution results instead of pretending.
        const dynamicContext = buildDynamicContext({
            runningContext,
            intent: this.lastIntent,
            plan: this.lastPlan,
            execution: this.lastPlanResult,
            planningNote,
        })
        

        for (let i = 0; i < this.MAX_LOOP; i++) {
            // Step C: inject the dynamic context into the system prompt itself,
            // immediately before the LLM call — so the base instructions are
            // never replaced, only augmented with labelled memory + execution
            // sections from the Memory and Planning engines.
            const systemContent = dynamicContext
                ? `${this.instructions}\n\n${dynamicContext}`
                : this.instructions

            const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'developer'; content: string }> = [
                { role: 'system', content: systemContent },
            ]

            // Full short-term message history.
            messages.push(
                ...this.memory.getMessages().map(e => ({ role: e.role, content: e.content })),
            )

            const llmResponse = await this.callLlm(messages)

            const rawLLMResponse: string | null = llmResponse

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

    /**
     * Phase 2 — Task route: Intent(task) → Planner → IPlan → PlanExecutor →
     * Tools → Results. Sets {@link lastPlan} / {@link lastPlanResult} which the
     * dynamic context then renders as [Current task] / [Execution].
     *
     * Returns a clarification note when no plan could be established, otherwise
     * `null`. Never throws: a planner/executor failure degrades to the normal
     * retrieval + memory path so the conversation is never broken.
     */
    private async runTaskPlan(
        query: string,
        intent: IIntentResult,
        runningContext: string | null,
    ): Promise<string | null> {
        if (!this.planner || !this.planExecutor) return null

        try {
            const planned = await this.planner.createPlan({
                goal: query,
                intent,
                context: runningContext,
            })

            if (!planned.plan) {
                log(`[Planner] No plan for this task (reason: ${planned.reason}). Asking for clarification.`)
                if (planned.reason === "llm-unavailable") {
                    return "No LLM planner is configured for this deployment, so the task cannot be planned automatically."
                }
                if (planned.reason === "invalid-plan") {
                    return [
                        "The generated plan failed structural validation and was rejected.",
                        ...(planned.errors ?? []).slice(0, 3).map(e => `Validation error: ${e}`),
                    ].join("\n")
                }
                return "The task could not be planned automatically. Ask the user a short clarifying question instead of guessing."
            }

            this.lastPlan = planned.plan
            log(`[Planner] Plan ${planned.plan.id} created (source: ${planned.source ?? "unknown"}) with ${planned.plan.steps.length} step(s).`)

            const result = await this.planExecutor.execute(planned.plan)
            this.lastPlanResult = result
            log(`[PlanExecutor] Plan ${result.planId} finished: ${result.status}.`)

            return null
        } catch (error) {
            log(`[Planner] Planning failed, continuing without a plan: ${error instanceof Error ? error.message : String(error)}`)
            return null
        }
    }

    /**
     * LLM planner hook. Returns undefined when no OpenAI key is configured, so
     * the Planner uses its deterministic rule-based fallback (this is also the
     * path unit tests take — no network, no API key needed).
     */
    private createLlmPlannerHook(): ((prompt: string) => Promise<string | null>) | undefined {
        // A responder seam means the caller wants a fully deterministic agent
        // (tests / custom runtimes) — keep planning deterministic too.
        if (this.responder) return undefined
        if (!process.env.OPENAI_API_KEY) return undefined
        return async (prompt: string) => {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
            })
            return response.choices[0]?.message.content ?? null
        }
    }

    /**
     * Call the LLM for one iteration. Uses the injected responder/OpenAI seam
     * ({@link AgentBuilder.withResponder}) when available, otherwise the
     * built-in OpenAI client. `messages` are the full system + history array,
     * and the responder receives a lightweight (role, content) form.
     */
    private async callLlm(
        messages: ReadonlyArray<{ role: string; content: string }>,
    ): Promise<string | null> {
        if (this.responder) {
            return this.responder(messages)
        }

        const llmResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages as unknown as Array<import('openai/resources/chat/completions/completions.js').ChatCompletionMessageParam>,
        })
        return llmResponse.choices[0]?.message.content ?? null
    }
}