/**
 * MemoryProcessor module.
 *
 * A MemoryProcessor reads and analyses the conversation history stored in an
 * {@link IMemory} source. It is deliberately read-only: it never mutates the
 * history, it only reads snapshots through the {@link IMemory} abstraction.
 *
 * Later stages (background scheduler, structured extraction of summary /
 * facts / relations / feedback) will build on top of the read access defined
 * here.
 */

import type { IMessage, IMemory } from './memory.js'

export type MessageRole = IMessage['role']

export interface IHistoryFilter {
    /** Only keep messages with this role (or one of these roles). */
    role?: MessageRole | readonly MessageRole[]
    /** Only keep the most recent `limit` messages. */
    limit?: number
}

export class MemoryProcessor {
    private readonly memory: IMemory

    constructor(memory: IMemory) {
        this.memory = memory
    }

    /** The underlying conversation memory this processor reads from. */
    public get source(): IMemory {
        return this.memory
    }

    /** Total number of messages currently stored in the history. */
    public get messageCount(): number {
        return this.memory.length
    }

    /** Read the entire conversation history as an immutable snapshot. */
    public readHistory(): readonly IMessage[] {
        return this.memory.getMessages()
    }

    /** Read the most recent `count` messages, in chronological order. */
    public readRecent(count: number): readonly IMessage[] {
        if (count <= 0) return []
        const messages = this.memory.getMessages()
        return messages.slice(Math.max(0, messages.length - count))
    }

    /** Read only the messages produced by a single role. */
    public readByRole(role: MessageRole): readonly IMessage[] {
        return this.memory.getMessages().filter(message => message.role === role)
    }

    /** Read the messageHistory filtered by role and/or a recent window. */
    public query(filter: IHistoryFilter = {}): readonly IMessage[] {
        const { role, limit } = filter
        const messages = this.memory.getMessages()

        const roleFiltered = role
            ? messages.filter(message =>
                Array.isArray(role) ? role.includes(message.role) : message.role === role)
            : messages

        if (typeof limit !== 'number') return roleFiltered
        if (limit <= 0) return []
        return roleFiltered.slice(Math.max(0, roleFiltered.length - limit))
    }
}