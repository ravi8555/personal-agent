/**
 * MemoryExtraction module — Step 4 of the memory architecture.
 *
 * Turns a batch of conversation messages into structured, long-term-usable
 * memory:
 *
 *   - summary    : a concise description of the conversation segment
 *   - facts      : atomic statements worth remembering about the user/world
 *   - relations  : subject-predicate-object triples between entities
 *   - feedback   : user signals (praise / correction / preference / complaint)
 *
 * This is the "Memory extraction" box that the MemoryScheduler (Step 3) runs
 * every 3 minutes, and its output feeds normalization (Step 6), Cypher
 * generation (Step 7) and graph insertion (Step 8).
 */

import type { IMessage } from './memory.js'

export type ExtractionFeedbackType =
    | 'praise'
    | 'correction'
    | 'preference'
    | 'complaint'
    | 'note'

export interface IExtractedRelation {
    subject: string
    predicate: string
    object: string
    /** Optional model confidence in [0,1]. */
    confidence?: number
}

export interface IExtractedFeedback {
    type: ExtractionFeedbackType
    text: string
}

export interface IMemoryExtraction {
    /** One or two sentence summary of the conversation segment. */
    summary: string
    /** Atomic, long-term-usable factual statements. */
    facts: string[]
    /** Subject-predicate-object triples between entities. */
    relations: IExtractedRelation[]
    /** User feedback / evaluation signals. */
    feedback: IExtractedFeedback[]
    /** ISO timestamp of when the extraction was produced. */
    extractedAt: string
}

/**
 * Minimal LLM seam: given a fully built prompt, return the raw model text
 * (or null when the model produced nothing). Tests inject a fake responder.
 */
export type ExtractionResponder = (prompt: string) => Promise<string | null>

export interface IMemoryExtractor {
    extract(batch: readonly IMessage[]): Promise<IMemoryExtraction>
}

/** An extraction with every field empty. */
export function emptyExtraction(extractedAt = new Date().toISOString()): IMemoryExtraction {
    return { summary: '', facts: [], relations: [], feedback: [], extractedAt }
}

const EXTRACTION_INSTRUCTIONS = `You are a memory-extraction engine for an AI assistant.

Analyse the conversation segment below and produce a structured memory record.
Return STRICT JSON only, with exactly this shape and nothing else:
{
  "summary": "one or two sentence summary of the segment",
  "facts": ["standalone factual statement", "..."],
  "relations": [
    {"subject": "...", "predicate": "...", "object": "..."}
  ],
  "feedback": [
    {"type": "praise | correction | preference | complaint | note", "text": "..."}
  ]
}

Rules:
- summary: concise and factual; capture what happened and the outcome.
- facts: atomic, verifiable statements worth remembering long-term. Include
  statements the user made about themselves or their preferences. Do not
  include tool internals or transient weather/tool results.
- relations: subject-predicate-object triples between named entities, e.g.
  {"subject": "User", "predicate": "lives in", "object": "Goa"}. Use a
  consistent, simple verb phrase as the predicate. When the user has no given
  name, use "User" as the subject.
- feedback: include only text where the user expressed an evaluation or
  preference. type meanings: praise = explicit positive, correction = explicit
  wrong answer, preference = stated preference, complaint = negative,
  note = anything else.
- If a category has nothing to add, use an empty array []. Never invent
  facts, relations or feedback.`

function buildExtractionPrompt(batch: readonly IMessage[]): string {
    const labelOf: Record<IMessage['role'], string> = {
        user: 'USER',
        assistant: 'ASSISTANT',
        developer: 'TOOL',
    }
    const conversation = batch
        .map(message => `${labelOf[message.role]}: ${message.content}`)
        .join('\n\n')

    return `${EXTRACTION_INSTRUCTIONS}\n\nConversation segment:\n${conversation}`
}

const FEEDBACK_TYPES: readonly ExtractionFeedbackType[] = [
    'praise',
    'correction',
    'preference',
    'complaint',
    'note',
]

function stripCodeFence(raw: string): string {
    const trimmed = raw.trim()
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
    return match ? (match[1] ?? trimmed) : trimmed
}

function normalizeExtraction(data: unknown, extractedAt: string): IMemoryExtraction {
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>

    const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : ''

    const facts = Array.isArray(record['facts'])
        ? record['facts']
              .filter((fact): fact is string => typeof fact === 'string')
              .map(fact => fact.trim())
              .filter(fact => fact.length > 0)
        : []

    const relations = Array.isArray(record['relations'])
        ? record['relations']
              .map(normalizeRelation)
              .filter((relation): relation is IExtractedRelation => relation !== null)
        : []

    const feedback = Array.isArray(record['feedback'])
        ? record['feedback']
              .map(normalizeFeedback)
              .filter((item): item is IExtractedFeedback => item !== null)
        : []

    return { summary, facts, relations, feedback, extractedAt }
}

function normalizeRelation(item: unknown): IExtractedRelation | null {
    if (typeof item !== 'object' || item === null) return null
    const record = item as Record<string, unknown>

    const subject = typeof record['subject'] === 'string' ? record['subject'].trim() : ''
    const predicate = typeof record['predicate'] === 'string' ? record['predicate'].trim() : ''
    const object = typeof record['object'] === 'string' ? record['object'].trim() : ''
    if (!subject || !predicate || !object) return null

    const relation: IExtractedRelation = { subject, predicate, object }
    const confidence = record['confidence']
    if (
        typeof confidence === 'number' &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1
    ) {
        relation.confidence = confidence
    }
    return relation
}

function normalizeFeedback(item: unknown): IExtractedFeedback | null {
    if (typeof item !== 'object' || item === null) return null
    const record = item as Record<string, unknown>

    const rawType = record['type']
    const type: ExtractionFeedbackType =
        typeof rawType === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(rawType)
            ? (rawType as ExtractionFeedbackType)
            : 'note'

    const text = typeof record['text'] === 'string' ? record['text'].trim() : ''
    if (!text) return null

    return { type, text }
}

export class MemoryExtractor implements IMemoryExtractor {
    private readonly respond: ExtractionResponder

    constructor(respond: ExtractionResponder) {
        this.respond = respond
    }

    public async extract(batch: readonly IMessage[]): Promise<IMemoryExtraction> {
        const extractedAt = new Date().toISOString()
        if (batch.length === 0) return emptyExtraction(extractedAt)

        const raw = await this.respond(buildExtractionPrompt(batch))
        if (raw === null) return emptyExtraction(extractedAt)

        let data: unknown
        try {
            data = JSON.parse(stripCodeFence(raw))
        } catch {
            // Model did not return valid JSON — fall back to an empty record
            // so the extraction pipeline never crashes on a bad response.
            return emptyExtraction(extractedAt)
        }

        return normalizeExtraction(data, extractedAt)
    }
}