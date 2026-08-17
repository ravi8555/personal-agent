import { log } from "node:console"
import { HARNESS_PROMPTS } from "./config.js"
import { Memory } from "./memory.js"
import { MemoryProcessor } from "./memoryProcessor.js"
import type { IMessage, IMemory, MessageListener } from "./memory.js"
import Openai from 'openai'
import "dotenv/config"

export type { IMessage, IMemory, MessageListener } from './memory.js'

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

    public build() {
        return new Agent(this)
    }
}

export class Agent {
    private readonly instructions: string
    private readonly memory: IMemory
    private readonly memoryProcessor: MemoryProcessor
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
    }

    /** The memory / conversation-history backing this agent. */
    public getMemory(): IMemory {
        return this.memory
    }

    /** A processor for reading / analysing the agent's conversation history. */
    public getMemoryProcessor(): MemoryProcessor {
        return this.memoryProcessor
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