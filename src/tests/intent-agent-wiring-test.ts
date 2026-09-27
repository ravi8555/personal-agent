// Phase 1 — Agent ↔ IntentEngine wiring (responder seam, no Neo4j/OpenAI).
import assert from "node:assert/strict";
import { Agent } from "../app/agent.js";
import type { AgentResponder } from "../app/agent.js";
import type { IntentDetector } from "../app/intentEngine.js";

console.log(`
==================================================
AGENT + INTENT ENGINE WIRING TEST (Phase 1)
==================================================
`);

const responder: AgentResponder = async () =>
    JSON.stringify({ step: "output", content: "ok" });

// --- 1. default classifier + getLastIntent across all three types ---
{
    const agent = Agent.builder()
        .setInstructions("test agent")
        .withResponder(responder)
        .build();

    assert.equal(agent.getLastIntent(), null, "lastIntent starts null");

    await agent.run("What is the weather in Pune?");
    assert.equal(agent.getLastIntent()?.type, "question");

    await agent.run("Create a reminder for gym at 7am");
    assert.equal(agent.getLastIntent()?.type, "task");

    await agent.run("Actually, I like coffee now.");
    const last = agent.getLastIntent();
    assert.equal(last?.type, "conversation");
    assert.ok(last?.signals.includes("correction"), `correction signal: ${last?.signals.join(",")}`);
    assert.ok(last?.signals.includes("preference"), `preference signal: ${last?.signals.join(",")}`);
    console.log("  PASS default classifier + getLastIntent (question/task/conversation+correction)");
}

// --- 2. injected fake detector (no OpenAI dependency) ---
{
    const fake: IntentDetector = () => ({
        type: "question",
        confidence: 1,
        signals: ["test"],
        raw: "test",
    });
    const agent = Agent.builder()
        .setInstructions("test agent")
        .withResponder(responder)
        .withIntentDetector(fake)
        .build();

    await agent.run("Create a reminder for gym at 7am");
    assert.equal(agent.getLastIntent()?.type, "question", "injected detector wins over rules");
    assert.deepEqual(agent.getLastIntent()?.signals, ["test"]);
    console.log("  PASS withIntentDetector injection overrides default classifier");
}

// --- 3. task does NOT short-circuit: full run() still completes ---
{
    const seen: string[] = [];
    const loggingAgent = Agent.builder()
        .setInstructions("test agent")
        .withResponder(responder)
        .build();
    loggingAgent.attachInterceptor(m => seen.push(`${m.role}:${m.content.slice(0, 40)}`));

    const history = await loggingAgent.run("Schedule a meeting tomorrow");
    assert.equal(loggingAgent.getLastIntent()?.type, "task");
    assert.ok(history && history.length >= 2, "run() completes user+assistant turns for tasks");
    assert.ok(seen.some(s => s.startsWith("assistant:")), "assistant reply still produced for tasks");
    console.log("  PASS task continues through the unchanged Memory → Context → LLM path");
}

console.log("\n✅ Agent + Intent Engine wiring: all passed.");
