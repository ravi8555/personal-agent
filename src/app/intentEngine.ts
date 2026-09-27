/**
 * Phase 1 — Intent Engine (classification only, no routing / no execution).
 *
 * Every user message is labelled as one of three primary intents:
 *   - "question"     — "What is...", "Do you remember...", "What do you know..."
 *   - "task"         — "Create...", "Schedule...", "Remind me to..." (STUB)
 *   - "conversation" — "I like...", "My name is...", "Hi", corrections (default)
 *
 * Rich `signals` carry the nuance (greeting, preference, memory-query,
 * correction, ...) so Phase 2 (Planning Engine) can act without re-parsing.
 * `confidence` is a rule-engine confidence score (signal strength), NOT a
 * probability: strong patterns → 0.90–0.97, moderate → 0.75–0.89,
 * fallback conversation → 0.60–0.74.
 *
 * Pure + deterministic: no LLM, no I/O. Safe to call on every turn.
 */

export type IntentType = "question" | "task" | "conversation";

export interface IIntentResult {
    type: IntentType;
    confidence: number;
    signals: string[];
    raw: string;
}

/** Injectable classifier seam (mirrors AgentBuilder.withIntentDetector). */
export type IntentDetector = (message: string) => IIntentResult;


/** Strong task verbs: leading imperative => strong task signal. */
const STRONG_TASK_VERBS = [
    "create",
    "schedule",
    "send",
    "book",
    "add",
    "delete",
    "remove",
    "update",
    "change",
    "modify",
    "plan",
    "generate",
    "write",
    "draft",
    "fetch",
    "compare",
    "summarize",
    "calculate",
    "set",
    "cancel",
    "move",
    "rename",
    "open",
    "close",
];

/**
 * Weak task verbs: only a moderate signal even in leading position, so
 * "Get going" / "Find peace" style sentences are not forced into tasks.
 */
const WEAK_TASK_VERBS = ["get", "find", "search", "check"];

/** Phrases that explicitly query stored memory (force `question`). */
const MEMORY_QUERY_PHRASES = [
    "do you remember",
    "do you recall",
    "what do you know about",
    "what have i told you",
    "what did i tell you",
    "what did i say about",
    "what do you remember about",
    "remind me what",
    "what you remember",
    "what you know about",
    "what i told you about",
    "what i have told you",
];

/** Explicit correction markers (conversation/correction, never a task). */
const CORRECTION_MARKERS = [
    "actually",
    "correction",
    "no wait",
    "i meant",
    "i mean",
    "changed my mind",
    "rather ",
    "scratch that",
    "update that to",
    "forget what i said",
];

/** Greeting openers. */
const GREETING_RE = /^(hi|hey|hello|yo|howdy|good morning|good afternoon|good evening|hiya|greetings)\b/;

/** Acknowledgement / casual closers. */
const ACK_RE = /\b(thanks|thank you|thx|got it|ok|okay|great|perfect|nice|awesome|cool|understood)\b/;

/** Wh-words that open questions. */
const WH_RE = /^(what|why|how|when|where|who|whom|whose|which)\b/;

/** Auxiliary openers that usually mark questions. */
const AUX_RE = /^(is|are|was|were|do|does|did|can|could|would|should|will|have|has|tell me)\b/;


export function detectIntent(message: string): IIntentResult {
    const raw = (message ?? "").trim();
    const lower = raw.toLowerCase().replace(/\s+/g, " ").trim();
    const signals: string[] = [];

    if (!lower) {
        return { type: "conversation", confidence: 0.6, signals: ["empty"], raw };
    }

    const endsQ = /\?\s*$/.test(raw);
    if (endsQ) signals.push("question-mark");

    // --- memory-query (strong question cue, suppresses task "remind") ---
    const hasMemoryQuery = MEMORY_QUERY_PHRASES.some(p => lower.includes(p));
    if (hasMemoryQuery) signals.push("memory-query");

    // --- correction ---
    const hasCorrection = CORRECTION_MARKERS.some(m => lower.includes(m));
    if (hasCorrection) signals.push("correction");

    // --- preference ("i like/love/prefer/dislike...") ---
    const hasExplicitPref =
        /\bi\s+(really\s+)?(like|love|enjoy|prefer|hate|dislike|don't like|dont like|do not like|can't stand|cant stand)\b/.test(lower);
    const hasGeneralPref =
        hasExplicitPref || /\b(my favourite|my favorite|i prefer|preference)\b/.test(lower);
    if (hasGeneralPref) signals.push("preference");
    if (hasExplicitPref) signals.push("explicit-preference");

    // --- personal fact ---
    if (/\b(my name is|i live in|i am a|i'm a|i work as|i work at|i was born|my birthday is)\b/.test(lower)) {
        signals.push("personal-fact");
    }

    // --- opinion ---
    if (/\b(i think|in my opinion|i believe|i feel that|i feel like)\b/.test(lower)) {
        signals.push("opinion");
    }

    // --- greeting / acknowledgement ---
    if (GREETING_RE.test(lower)) signals.push("greeting");
    if (ACK_RE.test(lower)) signals.push("acknowledgement");

    // --- question cues ---
    const whMatch = lower.match(WH_RE);
    if (whMatch) signals.push(`wh-word:${whMatch[1]}`);
    const auxMatch = lower.match(AUX_RE);
    if (auxMatch) signals.push(`aux-open:${auxMatch[1]}`);
    if (/\b(can you|could you|would you|will you|do you|tell me|explain|remind me what)\b/.test(lower)) {
        if (!signals.includes("question-cue")) signals.push("question-cue");
    }
    if (/\b(recommend|suggest)\b/.test(lower)) signals.push("recommendation-request");
    if (/\b(buy|purchase|order)\b/.test(lower) || /\bneed to buy\b/.test(lower) || /\bwant to buy\b/.test(lower)) {
        signals.push("purchase-intent");
    }

    // --- task cues ---
    // Strip a leading "please " for imperative detection ("please create...").
    const withoutPlease = lower.replace(/^please\s+/, "");
    const firstWord = (withoutPlease.match(/^[a-z]+/) ?? [""])[0];
    const hadPlease = /^please\s+/.test(lower);
    if (hadPlease) signals.push("please");

    const leadingStrong = STRONG_TASK_VERBS.includes(firstWord);
    const leadingWeak = WEAK_TASK_VERBS.includes(firstWord);
    if (leadingStrong) signals.push(`imperative:${firstWord}`);
    else if (leadingWeak) signals.push(`weak-imperative:${firstWord}`);

    const helpMeMatch = lower.match(/\bhelp me\b\s*([a-z]+)?/);
    if (helpMeMatch) {
        signals.push("help-me-request");
        if (helpMeMatch[1]) signals.push(`help-me-verb:${helpMeMatch[1]}`);
    }
    if (/\bi need (to|you to)\b/.test(lower)) signals.push("need-request");
    if (/\bi want (to|you to)\b/.test(lower)) signals.push("want-request");
    if (/\bcan you (please\s+)?(create|schedule|send|book|add|delete|remove|update|set|remind|find|search|check|write|draft|generate|plan|fetch|compare|summarize|calculate|cancel|move|help)\b/.test(lower)) {
        signals.push("can-you-task");
    }
    // "Remind me TO ..." / "reminder for ..." = task — but
    // "remind me WHAT ..." is a memory query (handled above, NOT a task).
    if (/\bremind me (to|at|on)\b/.test(lower) || /\breminder for\b/.test(lower) || /\bremind me tomorrow\b/.test(lower)) {
        signals.push("reminder-request");
    }

    let taskScore = 0;
    let questionScore = 0;
    let conversationScore = 1.0; // default baseline

    if (leadingStrong) taskScore += 3;
    if (leadingWeak) taskScore += 1;
    if (signals.includes("reminder-request")) taskScore += 3;
    if (signals.includes("help-me-request")) taskScore += 3;
    if (signals.includes("can-you-task")) taskScore += 2;
    if (signals.includes("need-request")) taskScore += 2;
    if (signals.includes("want-request")) taskScore += 1.5;
    if (hadPlease && (leadingStrong || leadingWeak)) taskScore += 1;
    else if (hadPlease && /\b(create|schedule|send|book|add|delete|remove|update|remind|find|search|write|draft)\b/.test(lower)) {
        taskScore += 2;
    }
    // Buried imperative mid-sentence ("Create a reminder: ...") still counts.
    if (!leadingStrong && !leadingWeak) {
        const buried = STRONG_TASK_VERBS.some(v => new RegExp(`\\b${v}\\b`).test(lower));
        if (buried && !hasMemoryQuery) taskScore += 1.5;
    }

    if (hasMemoryQuery) questionScore += 4; // overrides task "remind"
    if (whMatch) questionScore += 2;
    if (auxMatch) questionScore += 1.5;
    if (endsQ) questionScore += 1.5;
    if (signals.includes("question-cue")) questionScore += 1;
    if (signals.includes("recommendation-request") && endsQ) questionScore += 0.5;

    if (signals.includes("greeting")) conversationScore += 2;
    if (signals.includes("acknowledgement")) conversationScore += 2;
    if (signals.includes("preference")) conversationScore += 2;
    if (signals.includes("personal-fact")) conversationScore += 2;
    if (signals.includes("opinion")) conversationScore += 1.5;
    if (hasCorrection) conversationScore += 1.5;
    if (!endsQ && taskScore === 0 && questionScore === 0) conversationScore += 1;

    // Correction + preference guard: a correction sentence (without a
    // memory-query) can never escape into task/question via a buried verb,
    // so the ConflictDetector pipeline downstream is never disturbed.
    if (hasCorrection && !hasMemoryQuery) {
        taskScore = Math.min(taskScore, 1);
        questionScore = Math.min(questionScore, 1);
    }

    let type: IntentType = "conversation";
    let top = conversationScore;
    if (questionScore > top) {
        type = "question";
        top = questionScore;
    }
    if (taskScore > top) {
        type = "task";
        top = taskScore;
    }
    // Mixed task+question ("...buy a coffee machine, can you recommend one?"):
    // task-leaning cues + a question shape => task wins.
    if (type === "question" && taskScore >= 2 && taskScore >= questionScore - 1) {
        type = "task";
        top = taskScore;
    }
    // Memory-query always resolves to question (checked after mixed rule).
    if (hasMemoryQuery) {
        type = "question";
        top = questionScore;
    }

    const strongHit =
        hasMemoryQuery ||
        leadingStrong ||
        signals.includes("reminder-request") ||
        signals.includes("help-me-request") ||
        ((whMatch != null || auxMatch != null) && endsQ);
    const moderateHit =
        !strongHit &&
        (leadingWeak ||
            endsQ ||
            whMatch != null ||
            auxMatch != null ||
            signals.includes("question-cue") ||
            signals.includes("need-request") ||
            signals.includes("want-request") ||
            signals.includes("can-you-task") ||
            taskScore >= 1.5 ||
            questionScore >= 1.5);

    let confidence: number;
    if (strongHit) {
        confidence = 0.9 + 0.02 * Math.min(signals.length, 3);
    } else if (moderateHit) {
        confidence = 0.78 + 0.02 * Math.min(signals.length, 4);
    } else {
        confidence = 0.62 + 0.02 * Math.min(signals.length, 4);
    }
    confidence = Math.min(0.97, Math.round(confidence * 100) / 100);

    return { type, confidence, signals, raw };
}
