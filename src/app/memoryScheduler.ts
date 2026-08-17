/**
 * MemoryScheduler module.
 *
 * A background scheduler that periodically (default every 3 minutes) reads the
 * accumulated conversation history and hands the newly added messages to a
 * processing task. New messages are tracked by counting add-events on the
 * watched memory, so already-processed messages are never handed out a second
 * time, history clears are handled gracefully, and it never runs a task
 * concurrently with itself even when a tick takes longer than the interval.
 *
 * This is the scaffolding the structured-extraction step (summary / facts /
 * relations / feedback) will run on top of: pass a {@link MemoryTask} that
 * performs the extraction.
 */

import type { IMemory, IMessage } from './memory.js'
import { MemoryProcessor } from './memoryProcessor.js'

/** Default scheduling interval: 3 minutes in milliseconds. */
export const THREE_MINUTES_MS = 3 * 60 * 1000

/** Job invoked by the scheduler on each tick with the newly accumulated messages. */
export type MemoryTask = (
    batch: readonly IMessage[],
    processor: MemoryProcessor,
    scheduler: MemoryScheduler,
) => void | Promise<void>

export interface IMemorySchedulerOptions {
    /** The conversation memory to watch. */
    memory: IMemory
    /** Per-tick processing job. Defaults to a no-op that just advances the watermark. */
    task?: MemoryTask
    /** Interval between runs in ms. Defaults to {@link THREE_MINUTES_MS}. */
    intervalMs?: number
    /** When true, run a tick immediately on start(). Defaults to false. */
    runImmediately?: boolean
}

export class MemoryScheduler {
    private readonly memory: IMemory
    private readonly processor: MemoryProcessor
    private readonly task: MemoryTask
    private readonly intervalMs: number
    private readonly runImmediately: boolean
    private readonly unsubscribe: () => void

    private timer: ReturnType<typeof setInterval> | null = null
    private pendingCount = 0
    private processing = false

    constructor(options: IMemorySchedulerOptions) {
        this.memory = options.memory
        this.processor = new MemoryProcessor(options.memory)
        this.task = options.task ?? (() => {})
        this.intervalMs = options.intervalMs ?? THREE_MINUTES_MS
        this.runImmediately = options.runImmediately ?? false

        if (this.intervalMs <= 0) {
            throw new Error('MemoryScheduler: intervalMs must be a positive number')
        }

        // Count every message that is added while we are watching. Because the
        // count is driven by add-events (not by array indices), it stays
        // correct even when memory.clear() wipes history in between ticks.
        this.unsubscribe = this.memory.subscribe(() => {
            this.pendingCount++
        })

        // Messages already present when the scheduler is created count as
        // pending so the first tick can pick them up.
        this.pendingCount = this.memory.length
    }

    /** Whether the scheduler is currently running its interval. */
    public get isRunning(): boolean {
        return this.timer !== null
    }

    /** The conversation memory being watched. */
    public getMemory(): IMemory {
        return this.memory
    }

    /** The processor bound to the watched memory (for task callbacks). */
    public getProcessor(): MemoryProcessor {
        return this.processor
    }

    /** Stop watching the memory. */
    public dispose(): void {
        this.stop()
        this.unsubscribe()
    }

    /** Start the background loop. Safe to call multiple times. */
    public start(): MemoryScheduler {
        if (this.isRunning) return this
        this.timer = setInterval(() => {
            void this.tick()
        }, this.intervalMs)
        if (this.runImmediately) {
            void this.tick()
        }
        return this
    }

    /** Stop the background loop. In-flight ticks are left to finish. */
    public stop(): MemoryScheduler {
        if (this.timer !== null) {
            clearInterval(this.timer)
            this.timer = null
        }
        return this
    }

    /**
     * Run one processing pass now: hand every message that was added since the
     * last run to the task. Public so it can be invoked manually / tested.
     */
    public async tick(): Promise<void> {
        // Never run two ticks at the same time.
        if (this.processing) return
        this.processing = true
        try {
            const pending = this.pendingCount
            if (pending === 0) return

            const messages = this.memory.getMessages()

            if (pending > messages.length) {
                // The history was cleared/rebuilt since the last tick:
                // process whatever is currently present.
                if (messages.length > 0) {
                    await this.task(messages, this.processor, this)
                }
                this.pendingCount = 0
                return
            }

            const batch = messages.slice(messages.length - pending)
            if (batch.length > 0) {
                await this.task(batch, this.processor, this)
            }
            this.pendingCount = 0
        } finally {
            this.processing = false
        }
    }
}
