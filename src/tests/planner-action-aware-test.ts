// Phase 4B — Action-aware Planner test (no Neo4j, no OpenAI, no network).
// Proves: action catalog in prompt, live getters, action allow-list in the
// validator, LLM action plans surviving validation, and Agent E2E routing
// an LLM-produced action step through the Action Engine (4.1).
import assert from "node:assert/strict";

import { ActionRegistry, createDefaultActionRegistry } from "../app/action/actionRegistry.js";
import { ToolRegistry, createDefaultToolRegistry } from "../app/toolRegistry.js";
import { detectIntent } from "../app/intentEngine.js";
import { Planner, buildPlannerPrompt, normalizeSteps } from "../app/planner.js";
import { validatePlan } from "../app/planValidator.js";
import { PlanExecutor } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";
import { buildDynamicContext } from "../app/dynamicContext.js";
import { Agent } from "../app/agent.js";
import type { AgentResponder } from "../app/agent.js";

console.log(`
=================================================
ACTION-AWARE PLANNER TEST (Phase 4B)
catalog -> prompt -> validator -> executor -> Agent
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

// ---------------------------------------------------------------------------
// 1. buildPlannerPrompt: explicit action catalog section (4B)
// ---------------------------------------------------------------------------
{
    const intent = detectIntent("Create a short summary of my notes.");
    const prompt = buildPlannerPrompt(
        { goal: intent.raw, intent, context: null },
        ["web.search"],
        [{ name: "web.search", description: "Search the web" }],
        [
            { name: "text.summarize_local", description: "Deterministic local summarizer" },
            { name: "list.pick", description: "Pick items from a list" },
        ],
    );
    assert.ok(prompt.includes("Available tools"), "tools section present");
    assert.ok(prompt.includes("Available actions (internal, no approval needed"), "actions section present");
    assert.ok(prompt.includes("- text.summarize_local: Deterministic local summarizer"));
    assert.ok(prompt.includes("- list.pick: Pick items from a list"));
    assert.ok(prompt.includes('"action"?: string'), "schema advertises the action field");
    assert.ok(prompt.includes('kind steps name an action and set kind \\"action\\"') || prompt.includes('action steps name an action'), "rules distinguish tool vs action steps");
    ok("prompt: action catalog rendered as its own section (4.1 boundary explained)");

    // No action catalog → no empty section (matches Phase 3 prompts).
    const bare = buildPlannerPrompt({ goal: intent.raw, intent, context: null }, ["web.search"]);
    assert.ok(!bare.includes("Available actions"));
    ok("prompt: absent action catalog adds no empty section");
}


// ---------------------------------------------------------------------------
// 2. Validator: action allow-list (4B) — anonymous steps unaffected
// ---------------------------------------------------------------------------
{
    const knownActions = ["text.summarize_local", "list.pick", "note.compose"];

    const good = createPlanShell("summarize", [
        step("sum", "Summarize the provided text", { kind: "action", action: "text.summarize_local", args: { text: "x", maxLength: 200 } }),
        step("respond", "Report the summary", { kind: "response", dependsOn: ["sum"] }),
    ]);
    const goodResult = validatePlan(good, { knownActions });
    assert.equal(goodResult.valid, true, goodResult.errors.join(";"));
    ok("validator: registered action accepted");

    const bad = createPlanShell("x", [
        step("do", "Do the thing", { kind: "action", action: "ghost.do_thing" }),
    ]);
    const badResult = validatePlan(bad, { knownActions });
    assert.equal(badResult.valid, false);
    assert.ok(badResult.errors.some(e => e.includes("unknown action")));
    ok("validator: unregistered action rejected (allow-list like tools)");

    // Legacy/anonymous action steps stay valid — no action name to check.
    const anon = createPlanShell("x", [step("do", "Carry out the requested action", { kind: "action" })]);
    assert.equal(validatePlan(anon, { knownActions }).valid, true);
    // Without an allow-list, named actions are unchecked (opt-in semantics).
    assert.equal(validatePlan(bad).valid, true);
    ok("validator: anonymous action steps unaffected; allow-list is opt-in");
}


// ---------------------------------------------------------------------------
// 3. Planner: live action catalog + allow-list, LLM action plans survive
// ---------------------------------------------------------------------------
{
    const registry = createDefaultActionRegistry();
    let capturedPrompt = "";
    const planner = new Planner({
        knownTools: () => createDefaultToolRegistry().listTools().map(t => t.name),
        knownActions: () => registry.names(),
        actionCatalog: () => registry.entries(),
        generatePlan: async prompt => {
            capturedPrompt = prompt;
            return JSON.stringify({
                goal: "Prepare a short summary",
                steps: [
                    {
                        id: "summarize",
                        goal: "Summarize the provided text",
                        kind: "action",
                        action: "text.summarize_local",
                        args: { text: "Alpha beta gamma delta", maxLength: 10 },
                    },
                    { id: "respond", goal: "Report the summary", kind: "response", dependsOn: ["summarize"] },
                ],
            });
        },
    });
    const intent = detectIntent("Create a short summary of my notes.");
    const out = await planner.createPlan({ goal: intent.raw, intent });

    assert.ok(capturedPrompt.includes("- text.summarize_local"), "prompt shows the live action catalog");
    assert.ok(capturedPrompt.includes("Available actions"), "prompt has the actions section");
    assert.equal(out.reason, "ok", (out.errors ?? []).join(";"));
    assert.equal(out.source, "llm");
    assert.equal(out.plan?.steps[0]?.action, "text.summarize_local", "action field preserved through normalizeSteps");
    assert.equal(out.plan?.steps[0]?.kind, "action");
    assert.deepEqual(out.plan?.steps[1]?.dependsOn, ["summarize"]);
    ok("planner: LLM action plan validates against the live action allow-list");

    // Actions registered AFTER planner construction are visible (live getters).
    registry.register({ name: "demo.late", description: "registered later", execute: () => null });
    let latePrompt = "";
    const latePlanner = new Planner({
        knownActions: () => registry.names(),
        actionCatalog: () => registry.entries(),
        generatePlan: async prompt => {
            latePrompt = prompt;
            return JSON.stringify({
                goal: "late",
                steps: [{ id: "late", goal: "Run the late action", kind: "action", action: "demo.late" }],
            });
        },
    });
    const late = await latePlanner.createPlan({ goal: intent.raw, intent });
    assert.ok(latePrompt.includes("- demo.late: registered later"), "post-build action visible in prompt");
    assert.equal(late.reason, "ok", (late.errors ?? []).join(";"));
    ok("planner: live getters surface actions registered after construction");

    // Unknown action in the LLM plan → validator rejects → fallback plan.
    const strict = new Planner({
        knownTools: ["web.search"],
        knownActions: () => registry.names(),
        generatePlan: async () => JSON.stringify({
            goal: "bad",
            steps: [{ id: "x", goal: "Do something we cannot", kind: "action", action: "mystery.do" }],
        }),
    });
    const rejected = await strict.createPlan({ goal: intent.raw, intent });
    assert.equal(rejected.reason, "ok");
    assert.equal(rejected.source, "fallback");
    assert.ok(!rejected.plan?.steps.some(s => s.action === "mystery.do"), "unsafe LLM action must not survive");
    ok("planner: invalid LLM action plan rejected, deterministic plan replaces it");
}


// ---------------------------------------------------------------------------
// 4. Agent E2E: LLM action plan → Action Engine → [Execution] → LLM
// ---------------------------------------------------------------------------
{
    const actions = createDefaultActionRegistry();
    let plannerPrompt = "";
    const planner = new Planner({
        knownTools: () => createDefaultToolRegistry().listTools().map(t => t.name),
        knownActions: () => actions.names(),
        actionCatalog: () => actions.entries(),
        generatePlan: async prompt => {
            plannerPrompt = prompt;
            return JSON.stringify({
                goal: "Prepare a short summary of the provided text",
                steps: [
                    {
                        id: "summarize",
                        goal: "Summarize the provided text",
                        kind: "action",
                        action: "text.summarize_local",
                        args: { text: "Deploy the service before Friday; ping Ravi when done.", maxLength: 24 },
                    },
                    { id: "respond", goal: "Report the summary", kind: "response", dependsOn: ["summarize"] },
                ],
            });
        },
    });

    let captured = "";
    const responder: AgentResponder = async messages => {
        const sys = messages.find(m => m.role === "system");
        if (sys) captured = sys.content;
        return JSON.stringify({ step: "output", content: "Here is your summary." });
    };

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withActionRegistry(actions)
        .withPlanner(planner)
        .build();

    const messages = await agent.run("Create a short summary of my notes.");

    assert.equal(agent.getLastIntent()?.type, "task");
    assert.ok(plannerPrompt.includes("Available actions"), "agent planner prompt is action-aware");

    const plan = agent.getLastPlan();
    assert.ok(plan, "action plan produced");
    assert.equal(plan.status, "completed", "action plan executed end-to-end");
    const result = agent.getLastPlanResult();
    assert.ok(result);
    const summarizeStep = result.steps.find(s => s.stepId === "summarize");
    assert.equal(summarizeStep?.kind, "action");
    assert.equal(summarizeStep?.status, "completed");
    assert.deepEqual(summarizeStep?.output, { summary: "Deploy the service befor" }, "Action Engine produced the real output");
    ok("agent E2E: LLM action plan executes through the Action Engine");

    // Execution result reaches the LLM via labelled dynamic context (4D source).
    assert.ok(captured.includes("[Execution]"));
    assert.ok(captured.includes("Deploy the service befor"), "action output present in dynamic context");
    assert.ok(captured.includes('action "text.summarize_local"'), "execution bullets are kind/tool-tagged");
    ok("agent E2E: action output flows into [Execution] for the LLM");

    assert.ok(messages && messages.length > 0);
    const memory = agent.getMemory().getMessages();
    assert.ok(memory.some(m => m.role === "user" && m.content.includes("short summary")));
    assert.ok(memory.some(m => m.role === "assistant"));
    ok("agent E2E: conversation recorded (candidate source for 4E, no Neo4j write)");
}

console.log(`\n✅ Action-aware Planner: ${pass} checks passed.`);

