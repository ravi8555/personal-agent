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
    /** All recent user statements (chronological) that led to the current topic. */
    evidence: string[]
    /**
     * Older user statements (all but the most recent) that led to the current
     * topic. Empty when the topic has only a single statement in evidence.
     */
    historicalEvidence: string[]
    /** The most recent user statement for the current topic ('' when none). */
    latestEvidence: string
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
 * Split the topic's chronological evidence into the most recent statement
 * (latestEvidence) and everything before it (historicalEvidence).
 */
export function splitEvidence(evidence: readonly string[]): {
    historicalEvidence: string[]
    latestEvidence: string
} {
    if (evidence.length === 0) return { historicalEvidence: [], latestEvidence: '' }
    const latest = evidence[evidence.length - 1]
    return {
        historicalEvidence: evidence.slice(0, -1),
        latestEvidence: latest ?? '',
    }
}

/**
 * Render the full running context for the current topic — the graph knowledge
 * for the topic PLUS the user statements that produced it, split into
 * historical versus latest evidence so the LLM can tell which statement is
 * most recent (and therefore most likely to be the current belief):
 *
 *   [Relevant knowledge graph - topic: Coffee]
 *   Current relationship:
 *   - ravi LIKES coffee (confidence 0.95)
 *   Historical evidence:
 *   - "I don't like coffee."
 *   Latest evidence:
 *   - "Actually, I like coffee now."
 *   Facts: ... Feedback: ... Prior summaries: ...
 */
export function formatRunningContext(
    topic: ICurrentTopic,
    knowledge: IRelevantKnowledge,
): string {
    const lines: string[] = []
    const topicLabel = knowledge.topicLabel !== '' ? knowledge.topicLabel : knowledge.topicKey

    lines.push(`[Relevant knowledge graph - topic: ${topicLabel}]`)

    const { historicalEvidence, latestEvidence } = splitEvidence(topic.evidence)

    // Current (post-correction) relationships from the graph.
    if (knowledge.relations.length > 0) {
        lines.push('Current relationship:')
        for (const rel of knowledge.relations) {
            const confidence = rel.confidence !== null && rel.confidence !== undefined
                ? ` (confidence ${rel.confidence})`
                : ''
            lines.push(`- ${rel.subject} ${rel.predicate} ${rel.object}${confidence}`)
        }
    }

    // Evidence that produced the topic, oldest first, latest emphasised.
    if (historicalEvidence.length > 0) {
        lines.push('Historical evidence:')
        for (const statement of historicalEvidence) lines.push(`- "${statement}"`)
    }
    if (latestEvidence) {
        lines.push('Latest evidence:')
        lines.push(`- "${latestEvidence}"`)
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
    const { historicalEvidence, latestEvidence } = splitEvidence(topic.evidence)
    return {
        topic,
        knowledge,
        text: formatRunningContext(topic, knowledge),
        evidence: [...topic.evidence],
        historicalEvidence,
        latestEvidence,
    }
}