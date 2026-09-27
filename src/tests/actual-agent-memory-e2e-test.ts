import assert from "node:assert/strict";
import "dotenv/config";

import {
    Agent,
    type AgentResponder,
} from "../app/agent.js";

import { Memory } from "../app/memory.js";
import { defaultTopicAnalyzer } from "../app/contextWatcher.js";

import type { IRelevantKnowledge } from "../app/graphRetrieval.js";

console.log(`
==================================================
ACTUAL AGENT → DYNAMIC CONTEXT → LLM TEST
==================================================
`);

//
// --------------------------------------------------
// STEP 1 — Memory
// --------------------------------------------------
//

const memory = new Memory();


//
// --------------------------------------------------
// STEP 2 — Fake current graph state
// --------------------------------------------------
//
// This represents the graph AFTER:
//
// DISLIKES coffee
//       ↓
// user changes preference
//       ↓
// LIKES coffee
//       ↓
// ConflictDetector
//       ↓
// FeedbackEngine
//       ↓
// SelfCorrectionEngine
//       ↓
// DISLIKES deleted
//
// The Agent should therefore see only the latest
// relationship.
//

const currentKnowledge: IRelevantKnowledge = {
    topicKey: "coffee",
    topicLabel: "Coffee",
    entityFound: true,

    relations: [
        {
            subject: "ravi",
            predicate: "LIKES",
            object: "coffee",
            confidence: 0.95,
        },
    ],

    facts: [
        {
            text: "Ravi now likes coffee.",
            extractedAt: "2026-08-22T12:50:09.000+05:30",
        },
    ],

    feedback: [
        {
            type: "preference",
            text: "Ravi now likes coffee.",
        },
    ],

    summaries: [
        {
            text: "Ravi changed his preference and now likes coffee.",
            extractedAt: "2026-08-22T12:50:09.000+05:30",
        },
    ],
};


//
// --------------------------------------------------
// STEP 3 — Fake graph retriever
// --------------------------------------------------
//
// This replaces Neo4j only for this request-path test.
// We are testing:
//
// Agent
//   ↓
// ContextWatcher
//   ↓
// Retriever
//   ↓
// Running Context
//   ↓
// LLM
//
// The background/self-correction pipeline was already
// verified separately.
//

const knowledgeRetriever = async (
    topic: {
        topic: string;
        key: string;
        evidence: readonly string[];
        observedAt: string;
    },
): Promise<IRelevantKnowledge> => {

    console.log("\n===== RETRIEVER =====");

    console.log("Topic:");
    console.dir(topic, { depth: null });

    return currentKnowledge;
};


//
// --------------------------------------------------
// STEP 4 — Capture exactly what the LLM receives
// --------------------------------------------------
//

let capturedMessages:
    readonly { role: string; content: string }[] = [];

const responder: AgentResponder = async (messages) => {

    capturedMessages = messages;

    console.log("\n===== LLM RECEIVED =====");

    console.dir(messages, { depth: null });

    const systemMessage = messages.find(
        message => message.role === "system",
    );

    assert.ok(
        systemMessage,
        "LLM did not receive a system message",
    );

    console.log("\n===== SYSTEM PROMPT =====");
    console.log(systemMessage.content);

    //
    // The most important assertion:
    // the actual Agent must inject the latest graph
    // knowledge into the system prompt.
    //

    assert.ok(
        systemMessage.content.includes("ravi LIKES coffee"),
        "SYSTEM PROMPT FAILED: latest LIKES relation was not injected",
    );

    //
    // The superseded relation must NOT appear as the
    // current relation.
    //

    assert.ok(
        !systemMessage.content.includes("ravi DISLIKES coffee"),
        "SYSTEM PROMPT FAILED: superseded DISLIKES relation is still present",
    );

    assert.ok(
        systemMessage.content.includes("Ravi now likes coffee."),
        "SYSTEM PROMPT FAILED: current fact was not injected",
    );

    assert.ok(
        systemMessage.content.includes("Ravi changed his preference"),
        "SYSTEM PROMPT FAILED: current summary was not injected",
    );

    //
    // Verify the user's actual request also reached
    // the LLM.
    //

    const userMessage = messages.find(
        message => message.role === "user",
    );

    assert.ok(
        userMessage,
        "LLM did not receive the user message",
    );

    assert.equal(
        userMessage.content,
        "I want to buy a coffee machine.",
        "Incorrect user message reached LLM",
    );

    //
    // Return a deterministic Agent OUTPUT response.
    // Agent.run() expects JSON.
    //

    return JSON.stringify({
        step: "OUTPUT",
        text: "You like coffee, so I can help you choose a coffee machine.",
    });
};


//
// --------------------------------------------------
// STEP 5 — Build the REAL Agent
// --------------------------------------------------
//

const agent = Agent
    .builder()
    .setInstructions(
        "You are a personal assistant. Use relevant user knowledge when useful.",
    )
    .withMemory(memory)
    .withKnowledgeRetriever(knowledgeRetriever)
    .withResponder(responder)
    .build();


//
// --------------------------------------------------
// STEP 6 — Run the actual Agent
// --------------------------------------------------
//

console.log("\n===== RUNNING ACTUAL AGENT =====");

const result = await agent.run(
    "I want to buy a coffee machine.",
);


//
// --------------------------------------------------
// STEP 7 — Verify Agent response/history
// --------------------------------------------------
//

console.log("\n===== AGENT RESULT =====");

console.dir(result, { depth: null });

assert.ok(
    result,
    "Agent returned no conversation history",
);

assert.ok(
    result.some(
        message =>
            message.role === "user" &&
            message.content === "I want to buy a coffee machine.",
    ),
    "User message was not stored in Memory",
);

assert.ok(
    result.some(
        message =>
            message.role === "assistant" &&
            message.content.includes("You like coffee"),
    ),
    "Assistant response was not stored in Memory",
);


//
// --------------------------------------------------
// STEP 8 — Final assertions
// --------------------------------------------------
//

console.log("\n===== FINAL ASSERTIONS =====");

assert.ok(
    capturedMessages.length > 0,
    "Responder never received messages",
);

const finalSystemMessage = capturedMessages.find(
    message => message.role === "system",
);

assert.ok(
    finalSystemMessage,
    "No system message was captured",
);

assert.ok(
    finalSystemMessage.content.includes("ravi LIKES coffee"),
    "FINAL ASSERTION FAILED: LIKES coffee missing",
);

assert.ok(
    !finalSystemMessage.content.includes("ravi DISLIKES coffee"),
    "FINAL ASSERTION FAILED: DISLIKES coffee leaked into current context",
);

console.log("Memory → Agent: PASS");
console.log("Agent → ContextWatcher: PASS");
console.log("ContextWatcher → Retriever: PASS");
console.log("Retriever → RunningContext: PASS");
console.log("RunningContext → System Prompt: PASS");
console.log("System Prompt → LLM: PASS");
console.log("LLM → Agent Response: PASS");
console.log("Agent Response → Memory: PASS");

console.log(`
==================================================
ACTUAL AGENT MEMORY E2E RESULT: PASS
==================================================

DISLIKES coffee
      ↓
background processing
      ↓
self-correction
      ↓
LIKES coffee
      ↓
Actual Agent.run()
      ↓
ContextWatcher
      ↓
GraphKnowledgeRetriever
      ↓
Running Context
      ↓
System Prompt
      ↓
LLM
      ↓
Agent Response
`);

// npm exec tsx src/tests/actual-agent-memory-e2e-test.ts