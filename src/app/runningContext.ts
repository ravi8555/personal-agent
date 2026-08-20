/**
 * RunningContext module — Step 11 of the memory architecture.
 *
 * This connects the "Relevant Knowledge" branch of the architecture back into
 * the agent: relevant graph knowledge retrieved for the CURRENT conversation
 * topic (Step 10, via the ContextWatcher) is assembled into a human-readable
 * "running context" block and injected into the messages of the next LLM call.
 *
 *   relevant knowledge (graph)  +  current topic
 *                     │
 *                     ▼
 *             buildRunningContext() -> running context text
 *                     │
 *                     ▼
 *               next LLM call (Agent.run)
 *
 * The base instructions (harness + tools) are left untouched; only the dynamic
 * knowledge block is appended, so the base prompt is never replaced.
 */

import type { ICurrentTopic } from './contextWatcher.js'
import type { IRelevantKnowledge } from './graphRetrieval.js'

export interface IRunningContext {
    /** The current conversation topic the knowledge was retrieved for. */
    topic: ICurrentTopic
    /** The whole retrieved knowledge graph object. */
    knowledge: IRelevantKnowledge
    /** Human-readable block ready to be injected into the LLM prompt. */
    text: string
}

/** Human-readable label for a feedback type (falls back to 'note'). */
function feedbackTypeLabel(type: string): string {
    return type && type.length > 0 ? type : 'note'
}

/**
 * Render a retrieved knowledge graph into a readable context block.
 * Any category that is empty is omitted; a topic with no graph knowledge at
 * all renders a short "no knowledge" note rather than an empty header.
 */
export function formatRelevantKnowledge(knowledge: IRelevantKnowledge): string {
    const lines: string[] = []
    const topicLabel = knowledge.topicLabel !== '' ? knowledge.topicLabel : knowledge.topicKey

    lines.push(`[Relevant knowledge graph - topic: ${topicLabel}]`)

    const hasKnowledge =
        knowledge.relations.length > 0 ||
        knowledge.facts.length > 0 ||
        knowledge.feedback.length > 0 ||
        knowledge.summaries.length > 0

    if (!hasKnowledge) {
        lines.push('No long-term knowledge graph found for this topic yet.')
        return lines.join('\n')
    }

    if (knowledge.relations.length > 0) {
        lines.push('Relations:')
        for (const rel of knowledge.relations) {
            const confidence = rel.confidence !== null && rel.confidence !== undefined
                ? ` (confidence ${rel.confidence})`
                : ''
            lines.push(`- ${rel.subject} ${rel.predicate} ${rel.object}${confidence}`)
        }
    }

    if (knowledge.facts.length > 0) {
        lines.push('Facts:')
        for (const fact of knowledge.facts) lines.push(`- ${fact.text}`)
    }

    if (knowledge.feedback.length > 0) {
        lines.push('Feedback:')
        for (const fb of knowledge.feedback) {
            lines.push(`- [${feedbackTypeLabel(fb.type)}] ${fb.text}`)
        }
    }

    if (knowledge.summaries.length > 0) {
        lines.push('Prior summaries:')
        for (const summary of knowledge.summaries) lines.push(`- ${summary.text}`)
    }

    return lines.join('\n')
}

/**
 * Assemble the running context for the current topic. Returns null when there
 * is no knowledge to inject (no retriever available or nothing was retrieved).
 */
export function buildRunningContext(
    topic: ICurrentTopic,
    knowledge: IRelevantKnowledge | null,
): IRunningContext | null {
    if (!knowledge) return null
    return {
        topic,
        knowledge,
        text: formatRelevantKnowledge(knowledge),
    }
}