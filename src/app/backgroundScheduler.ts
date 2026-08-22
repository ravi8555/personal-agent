/**
 * BackgroundScheduler module — the 3-minute timer driver.
 *
 * Architectural decision (recorded here per the orchestration plan): the
 * interval timer lives in THIS class, not inside the BackgroundMemoryProcessor.
 * That keeps the pipeline testable — a test can simply `await
 * processor.process()` without waiting three minutes, while the production
 * application uses `scheduler.start()`.
 *
 *   BackgroundScheduler
 *       │  every 3 minutes
 *       ▼
 *   BackgroundMemoryProcessor (extract → normalize → write → topic → retrieve
 *                              → conflict → feedback → self-correct → state)
 *
 * The scheduler never inspects the agent: the processor below the agent layer
 * shares the same memory/graph components the agent does.
 */

import type { BackgroundMemoryProcessor } from './backgroundMemoryProcessor.js'
import { THREE_MINUTES_MS } from './memoryScheduler.js'

export interface IBackgroundMemoryProcessor {
    process(): Promise<void>
}

export interface IBackgroundSchedulerOptions {
    /** The processing pipeline to drive. */
    processor: IBackgroundMemoryProcessor
    /** Interval in ms. Defaults to THREE_MINUTES_MS (3 minutes). */
    intervalMs?: number
    /** Run one process() immediately on start(). Defaults to false. */
    runImmediately?: boolean
}

export class BackgroundScheduler {
    private readonly processor: IBackgroundMemoryProcessor
    private readonly intervalMs: number
    private readonly runImmediately: boolean

    private timer: ReturnType<typeof setInterval> | null = null

    constructor(options: IBackgroundSchedulerOptions) {
        this.processor = options.processor
        this.intervalMs = options.intervalMs ?? THREE_MINUTES_MS
        this.runImmediately = options.runImmediately ?? false

        if (this.intervalMs <= 0) {
            throw new Error('BackgroundScheduler: intervalMs must be a positive number')
        }
    }

    /** Whether the scheduler loop is currently running. */
    public get isRunning(): boolean {
        return this.timer !== null
    }

    /** The pipeline this scheduler drives. */
    public getProcessor(): IBackgroundMemoryProcessor  {
        return this.processor
    }

    /** Start the 3-minute loop. Safe to call multiple times. */
    public start(): BackgroundScheduler {
        if (this.isRunning) return this
        this.timer = setInterval(() => {
            void this.processor.process()
        }, this.intervalMs)
        if (this.runImmediately) {
            void this.processor.process()
        }
        return this
    }

    /** Stop the loop. In-flight processing is left to finish. */
    public stop(): BackgroundScheduler {
        if (this.timer !== null) {
            clearInterval(this.timer)
            this.timer = null
        }
        return this
    }
}