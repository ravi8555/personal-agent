import { log } from "node:console"
import { HARNESS_PROMPTS } from "./config.js"
import { Memory } from "./memory.js"
import { MemoryProcessor } from "./memoryProcessor.js"
import { MemoryScheduler } from "./memoryScheduler.js"
import type { IMemorySchedulerOptions } from "./memoryScheduler.js"
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

export class AgentBuilder {
    public instructions: string | undefined
    public toolList: ITool[]
    public memory: IMemory | undefined
    public memoryExtractor: IMemoryExtractor | undefined

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

    public build() {
        return new Agent(this)
    }
}

export class Agent {
    private readonly instructions: string
    private readonly memory: IMemory
    private readonly memoryProcessor: MemoryProcessor
    private memoryScheduler: MemoryScheduler | undefined
    private readonly memoryExtractor: IMemoryExtractor | undefined
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

    private async runExtraction(batch: readonly IMessage[], extractor: IMemoryExtractor): Promise<void> {
        const extraction = await extractor.extract(batch)
        this.memoryExtractions.push(extraction)
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

        

        for (let i = 0; i < this.MAX_LOOP; i++) {
            // Call LLM with the system prompt + full conversation history.
            const llmResponse = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: this.instructions },
                    ...this.memory.getMessages().map(e => ({ role: e.role, content: e.content }))
                ]
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