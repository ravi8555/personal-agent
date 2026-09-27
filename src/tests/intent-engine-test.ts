// Phase 1 — Intent Engine test (pure classifier: no Neo4j, no OpenAI).
import assert from "node:assert/strict";
import { detectIntent } from "../app/intentEngine.js";
import type { IntentType } from "../app/intentEngine.js";

console.log(`
==================================================
INTENT ENGINE TEST (Phase 1 — classification only)
==================================================
`);

interface Case {
    input: string;
    type: IntentType;
    signals?: string[];
    notType?: IntentType;
}

const CASES: Case[] = [
    // --- basic ---
    { input: "What is the weather in Pune?", type: "question" },
    { input: "Create a reminder for gym at 7am", type: "task" },
    { input: "I like coffee now.", type: "conversation", signals: ["preference"] },

    // --- memory queries (always question, never task) ---
    { input: "Do you remember I prefer tea?", type: "question", signals: ["memory-query"] },
    { input: "What do you know about my coffee preference?", type: "question", signals: ["memory-query"] },
    { input: "Remind me what I told you about coffee.", type: "question", signals: ["memory-query"] },
    { input: "Do you recall where I live?", type: "question", signals: ["memory-query"] },
    { input: "I was wondering what you remember about my projects.", type: "question", signals: ["memory-query"] },

    // --- conflict / correction (conversation, feeds ConflictDetector) ---
    { input: "I don't like coffee.", type: "conversation", signals: ["preference"] },
    { input: "Actually, I like coffee now.", type: "conversation", signals: ["preference", "correction"] },

    // --- mixed: task-leaning + question shape => task ---
    { input: "Create a reminder: what time is my meeting?", type: "task" },
    {
        input: "I need to buy a coffee machine, can you recommend one?",
        type: "task",
        signals: ["purchase-intent", "recommendation-request"],
    },

    // --- natural language ---
    { input: "Can you help me schedule something tomorrow?", type: "task" },
    { input: "Hey, I just wanted to tell you I prefer tea.", type: "conversation", signals: ["greeting", "preference"] },
    { input: "Hi", type: "conversation", signals: ["greeting"] },
    { input: "Thanks!", type: "conversation", signals: ["acknowledgement"] },
    { input: "My name is Ravi", type: "conversation", signals: ["personal-fact"] },

    // --- question guards: NOT tasks despite buried verbs ---
    { input: "What do you think I should buy?", type: "question", notType: "task" },
];

let passed = 0;
for (const c of CASES) {
    const r = detectIntent(c.input);
    assert.equal(r.type, c.type, `TYPE MISMATCH for ${JSON.stringify(c.input)}: got ${r.type} (${r.signals.join(",")})`);
    for (const s of c.signals ?? []) {
        assert.ok(r.signals.includes(s), `MISSING SIGNAL ${JSON.stringify(s)} for ${JSON.stringify(c.input)} (got: ${r.signals.join(",")})`);
    }
    if (c.notType) {
        assert.notEqual(r.type, c.notType, `UNEXPECTED ${c.notType} for ${JSON.stringify(c.input)}`);
    }
    // confidence bands: strong 0.90–0.97, moderate 0.75–0.89, fallback 0.60–0.74
    assert.ok(r.confidence >= 0.6 && r.confidence <= 0.97, `CONFIDENCE OUT OF BAND for ${JSON.stringify(c.input)}: ${r.confidence}`);
    assert.equal(r.raw, c.input.trim(), `RAW MISMATCH for ${JSON.stringify(c.input)}`);
    console.log(`  PASS [${r.type} ${r.confidence}] ${JSON.stringify(c.input)} -> ${r.signals.join(",")}`);
    passed++;
}

// --- confidence ordering: strong > fallback; bands respected ---
const strong = detectIntent("Create a reminder for gym at 7am");
const moderate = detectIntent("Find me something nice");
const fallback = detectIntent("Coffee is nice.");
assert.ok(strong.confidence >= 0.9, `strong band: ${strong.confidence}`);
assert.ok(moderate.confidence >= 0.75 && moderate.confidence < 0.9, `moderate band: ${moderate.confidence}`);
assert.ok(fallback.confidence <= 0.74, `fallback band: ${fallback.confidence}`);
assert.ok(fallback.confidence < moderate.confidence && moderate.confidence < strong.confidence,
    `ordering: ${fallback.confidence} < ${moderate.confidence} < ${strong.confidence}`);
console.log(`  PASS confidence bands: strong=${strong.confidence} moderate=${moderate.confidence} fallback=${fallback.confidence}`);

console.log(`\n✅ Intent Engine: ${passed}/${CASES.length} cases passed.`);
