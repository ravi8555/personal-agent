/**
 * Memory / conversation-history module.
 *
 * The Agent keeps NO history bookkeeping of its own: every message that
 * enters the conversation is handled exclusively through an {@link IMemory}
 * implementation. {@link Memory} is the default in-memory store; alternative
 * persistence (filesystem, database, graph store, ...) can be injected
 * through {@link AgentBuilder.withMemory}.
 */

export interface IMessage {
    role: 'user' | 'assistant' | 'developer'
    content: string
    /**
     * Stable message id, assigned by IMemory implementations when a message is
     * added. The background pipeline (BackgroundMemoryProcessor) uses these ids
     * to track its watermark ({@link IMemoryProcessingState.lastProcessedMessageId})
     * so it only ever processes NEW history.
     */
    id?: string
}

export type MessageListener = (message: IMessage) => void

/** Monotonic source of stable message ids (message-1, message-2, ...). */
let nextMessageId = 0
export function makeMessageId(): string {
    nextMessageId += 1
    return `message-${nextMessageId}`
}

export interface IMemory {
    /** Immutable snapshot of every message recorded so far. */
    getMessages(): readonly IMessage[]
    /** Number of recorded messages. */
    readonly length: number
    /** Record a single message. */
    add(message: IMessage): IMessage
    /** Convenience: record a user message. */
    addUser(content: string): IMessage
    /** Convenience: record an assistant message. */
    addAssistant(content: string): IMessage
    /** Convenience: record a developer / tool-result message. */
    addDeveloper(content: string): IMessage
    /** Subscribe to every new message. Returns an unsubscribe function. */
    subscribe(listener: MessageListener): () => void
    /** Drop all recorded messages. */
    clear(): void
}

export class Memory implements IMemory {
    private readonly history: IMessage[] = []
    private readonly listeners: MessageListener[] = []

    constructor(initialMessages: readonly IMessage[] = []) {
        for (const message of initialMessages) {
            this.history.push(message.id ? message : { ...message, id: makeMessageId() })
        }
    }

    get length(): number {
        return this.history.length
    }

    getMessages(): readonly IMessage[] {
        return [...this.history]
    }

    add(message: IMessage): IMessage {
        const stored = message.id ? message : { ...message, id: makeMessageId() }
        this.history.push(stored)
        this.notify(stored)
        return stored
    }

    addUser(content: string): IMessage {
        return this.add({ role: 'user', content })
    }

    addAssistant(content: string): IMessage {
        return this.add({ role: 'assistant', content })
    }

    addDeveloper(content: string): IMessage {
        return this.add({ role: 'developer', content })
    }

    subscribe(listener: MessageListener): () => void {
        this.listeners.push(listener)
        return () => {
            const index = this.listeners.indexOf(listener)
            if (index !== -1) this.listeners.splice(index, 1)
        }
    }

    clear(): void {
        this.history.length = 0
    }

    private notify(message: IMessage): void {
        for (const listener of this.listeners) {
            listener(message)
        }
    }
}