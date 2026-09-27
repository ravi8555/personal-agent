// Phase 2 — Planning Engine test (no Neo4j, no OpenAI, no network).
// Order mirrors the build: planTypes → planner → validator → registry → executor.
import assert from "node:assert/strict";

import { createPlanShell, TASK_PLAN_THRESHOLD, resolveStepKind } from "../app/planTypes.js";
import type { IPlan, IPlanStep } from "../app/planTypes.js";
import { validatePlan } from "../app/planValidator.js";
import { Planner, normalizeSteps } from "../app/planner.js";
import { PlanExecutor, formatPlanResult, summarizeExecution } from "../app/planExecutor.js";
import { buildDynamicContext } from "../app/dynamicContext.js";
import { ToolRegistry, createDefaultToolRegistry } from "../app/toolRegistry.js";
import { detectIntent } from "../app/intentEngine.js";
import { Agent } from "../app/agent.js";
import type { AgentResponder } from "../app/agent.js";

console.log(`
==================================================
PLANNING ENGINE TEST (Phase 2)
planTypes -> planner -> validator -> registry -> executor
==================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

// ---------------------------------------------------------------------------
// 1. planTypes
// ---------------------------------------------------------------------------
{
    const plan = createPlanShell("Find a coffee machine", [step("s1", "Search")]);
    assert.equal(plan.intent, "task");
    assert.equal(plan.status, "pending");
    assert.ok(plan.id.startsWith("plan-"), `plan id: ${plan.id}`);
    assert.ok(!Number.isNaN(Date.parse(plan.createdAt)), "createdAt must be ISO");
    assert.equal(TASK_PLAN_THRESHOLD, 0.75);
    assert.equal(resolveStepKind(step("a", "Do it", { tool: "t" })), "tool");
    assert.equal(resolveStepKind(step("b", "Report the result to the user")), "response");
    assert.equal(resolveStepKind(step("c", "Pick the best option")), "decision");
    assert.equal(resolveStepKind(step("d", "Something", { kind: "action" })), "action");
    ok("planTypes: plan shell + kind resolution (tool/response/decision/action)");
}

// ---------------------------------------------------------------------------
// 2. planValidator
// ---------------------------------------------------------------------------
{
    const good = createPlanShell("goal", [
        step("search", "Search coffee machines", { tool: "web.search", args: { query: "coffee" } }),
        step("filter", "Filter under 10000", { dependsOn: ["search"] }),
    ]);
    const goodResult = validatePlan(good, { knownTools: ["web.search"], requiredArgs: { "web.search": ["query"] } });
    assert.equal(goodResult.valid, true, `expected valid: ${goodResult.errors.join("; ")}`);
    ok("validator: accepts a well-formed plan");

    const dupes = createPlanShell("goal", [step("a", "A"), step("a", "B")]);
    const dupesResult = validatePlan(dupes);
    assert.equal(dupesResult.valid, false);
    assert.ok(dupesResult.errors.some(e => e.includes("duplicate step id")), dupesResult.errors.join(";"));
    ok("validator: rejects duplicate step ids");

    const unknownDep = createPlanShell("goal", [step("a", "A", { dependsOn: ["ghost"] })]);
    const unknownDepResult = validatePlan(unknownDep);
    assert.equal(unknownDepResult.valid, false);
    assert.ok(unknownDepResult.errors.some(e => e.includes("unknown step")), unknownDepResult.errors.join(";"));
    ok("validator: rejects dependsOn pointing at a missing step");

    const cycle = createPlanShell("goal", [
        step("a", "A", { dependsOn: ["b"] }),
        step("b", "B", { dependsOn: ["a"] }),
    ]);
    const cycleResult = validatePlan(cycle);
    assert.equal(cycleResult.valid, false);
    assert.ok(cycleResult.errors.some(e => e.includes("circular dependency")), cycleResult.errors.join(";"));
    ok("validator: rejects circular dependencies");

    const unknownTool = createPlanShell("goal", [step("a", "A", { tool: "mcp.gmail.send" })]);
    const unknownToolResult = validatePlan(unknownTool, { knownTools: ["web.search"] });
    assert.equal(unknownToolResult.valid, false);
    assert.ok(unknownToolResult.errors.some(e => e.includes("unknown tool")), unknownToolResult.errors.join(";"));
    // ...unless explicitly allowed (planner may reference future tools).
    const allowed = validatePlan(unknownTool, { knownTools: [], allowedUnknownTools: ["mcp.gmail.send"] });
    assert.equal(allowed.valid, true, allowed.errors.join(";"));
    ok("validator: rejects unregistered tools unless allow-listed");

    const missingArg = createPlanShell("goal", [step("a", "A", { tool: "web.search", args: {} })]);
    const missingArgResult = validatePlan(missingArg, {
        knownTools: ["web.search"],
        requiredArgs: { "web.search": ["query"] },
    });
    assert.equal(missingArgResult.valid, false);
    assert.ok(missingArgResult.errors.some(e => e.includes("missing required arg")), missingArgResult.errors.join(";"));
    ok("validator: enforces required tool arguments");

    const emptySteps = createPlanShell("goal", []);
    assert.equal(validatePlan(emptySteps).valid, false);
    ok("validator: rejects plans with no steps");
}

// ---------------------------------------------------------------------------
// 3. planner (LLM hook + deterministic fallback + threshold gate)
// ---------------------------------------------------------------------------
{
    const taskIntent = detectIntent("Create a reminder for gym at 7am");
    assert.equal(taskIntent.type, "task");

    // below threshold => no plan (caller asks/clarifies)
    const plannerGated = new Planner({});
    const gated = await plannerGated.createPlan({
        goal: "maybe do something",
        intent: { type: "task", confidence: 0.68, signals: ["weak"], raw: "maybe do something" },
    });
    assert.equal(gated.plan, null);
    assert.equal(gated.reason, "below-threshold");
    ok("planner: task + confidence < 0.75 => no plan (clarify)");

    // non-task intents never plan
    const questionOut = await plannerGated.createPlan({ goal: "What is the weather?", intent: detectIntent("What is the weather?") });
    assert.equal(questionOut.plan, null);
    assert.equal(questionOut.reason, "not-a-task");
    ok("planner: question/conversation never reach the planner");

    // no LLM hook => deterministic rule-based fallback plan (still valid)
    const fallbackOut = await plannerGated.createPlan({ goal: "Create a reminder for gym at 7am", intent: taskIntent });
    assert.equal(fallbackOut.reason, "ok", (fallbackOut.errors ?? []).join(";"));
    assert.equal(fallbackOut.source, "fallback", "LLM absence must be reported as source: fallback");
    assert.ok(fallbackOut.plan, "fallback plan must exist");
    assert.ok(fallbackOut.plan.steps.length >= 3, "fallback plan has steps");
    assert.ok(fallbackOut.plan.steps.every(s => s.status === "pending"), "steps start pending");
    assert.ok(fallbackOut.plan.steps.some(s => (s.dependsOn ?? []).length > 0), "dependency graph present");
    assert.ok(fallbackOut.plan.steps.every(s => s.kind), "every step carries a kind");
    ok("planner: rule-based fallback produces a valid, dependency-ordered, kind-tagged plan");

    // LLM hook returning strict JSON => plan uses exactly those steps
    const plannerLlm = new Planner({
        knownTools: ["web.search"],
        generatePlan: async () => JSON.stringify({
            goal: "Find three coffee machines under 10000",
            steps: [
                { id: "search", goal: "Search for coffee machines", tool: "web.search", args: { query: "coffee machine under 10000" } },
                { id: "filter", goal: "Filter results below 10000", dependsOn: ["search"] },
                { id: "compare", goal: "Compare three suitable machines", dependsOn: ["filter"] },
            ],
        }),
    });
    const llmIntent = detectIntent("I need to buy a coffee machine, can you recommend one?");
    const llmOut = await plannerLlm.createPlan({ goal: llmIntent.raw, intent: llmIntent, context: "ravi LIKES coffee" });
    assert.equal(llmOut.reason, "ok", (llmOut.errors ?? []).join(";"));
    assert.equal(llmOut.source, "llm", "a successful LLM plan must be labelled source: llm");
    assert.deepEqual(llmOut.plan?.steps.map(s => s.id), ["search", "filter", "compare"]);
    assert.equal(llmOut.plan?.steps[0]?.tool, "web.search");
    assert.deepEqual(llmOut.plan?.steps[1]?.dependsOn, ["search"]);
    ok("planner: LLM JSON becomes a validated IPlan (ids/tools/dependsOn preserved)");

    // LLM garbage => fall back, and SAY SO via source: "fallback"
    const plannerBad = new Planner({
        knownTools: ["web.search"],
        generatePlan: async () => "sorry, I cannot produce JSON today",
    });
    const badOut = await plannerBad.createPlan({ goal: taskIntent.raw, intent: taskIntent });
    assert.equal(badOut.reason, "ok", "must degrade to the fallback plan");
    assert.equal(badOut.source, "fallback");
    assert.ok(badOut.plan && badOut.plan.steps.length > 0);
    ok("planner: unparseable LLM output degrades to the deterministic plan (source: fallback)");

    // LLM returns a structurally INVALID plan (unknown tool) => fallback, not execution
    const plannerInvalid = new Planner({
        knownTools: ["web.search"],
        generatePlan: async () => JSON.stringify({
            goal: "bad",
            steps: [{ id: "x", goal: "Call a tool we do not have", tool: "mcp.gmail.send" }],
        }),
    });
    const invalidOut = await plannerInvalid.createPlan({ goal: taskIntent.raw, intent: taskIntent });
    assert.equal(invalidOut.reason, "ok");
    assert.equal(invalidOut.source, "fallback");
    assert.ok(!invalidOut.plan?.steps.some(s => s.tool === "mcp.gmail.send"), "unsafe LLM tool must not survive");
    ok("planner: invalid LLM plan is rejected, then replaced by the deterministic plan");

    // strict mode: no LLM planner configured => llm-unavailable
    const strict = new Planner({ requireLlm: true });
    const strictOut = await strict.createPlan({ goal: taskIntent.raw, intent: taskIntent });
    assert.equal(strictOut.plan, null);
    assert.equal(strictOut.reason, "llm-unavailable");
    assert.equal(strictOut.source, undefined);
    ok("planner: strict mode returns llm-unavailable instead of silently degrading");

    // The planner never executes anything: steps stay pending after createPlan.
    assert.ok(llmOut.plan?.steps.every(s => s.status === "pending"), "planner must not execute steps");
    ok("planner: createPlan() only proposes — no tool execution");

    // normalizeSteps: auto-chains missing dependencies
    const chained = normalizeSteps([
        { id: "a", goal: "A" },
        { id: "b", goal: "B" },
    ]);
    assert.deepEqual(chained?.[1]?.dependsOn, ["a"]);
    ok("planner: normalizeSteps auto-chains steps that omit dependsOn");
}


// ---------------------------------------------------------------------------
// 4. toolRegistry
// ---------------------------------------------------------------------------
{
    const registry = createDefaultToolRegistry();
    assert.deepEqual(registry.names().sort(), ["memory.note", "text.summarize", "web.search"]);
    assert.equal(registry.requiredArgs("web.search").includes("query"), true);

    const searchOut = await registry.execute("web.search", { query: "coffee machine" }) as { query: string };
    assert.equal(searchOut.query, "coffee machine");
    ok("registry: default tools registered and executable (web.search stub)");

    await assert.rejects(() => registry.execute("mcp.gmail.send", {}), /unknown tool/);
    ok("registry: executing an unknown tool rejects");

    const custom = new ToolRegistry();
    custom.register({
        name: "math.add",
        description: "adds two numbers",
        requiredArgs: ["a", "b"],
        async executor(args) { return Number(args["a"]) + Number(args["b"]); },
    });
    assert.equal(await custom.execute("math.add", { a: 2, b: 3 }), 5);
    assert.deepEqual(custom.requiredArgsMap(), { "math.add": ["a", "b"] });
    assert.throws(() => custom.register({ name: "", description: "x", async executor() { return null; } }), /non-empty name/);
    ok("registry: custom tools register, execute, and report required args");
}

// ---------------------------------------------------------------------------
// 5. planExecutor (dependency order, failure propagation, tool errors)
// ---------------------------------------------------------------------------
{
    const order: string[] = [];
    const registry = new ToolRegistry();
    for (const name of ["t.a", "t.b", "t.c"]) {
        registry.register({
            name,
            description: name,
            async executor() { order.push(name); return { ran: name }; },
        });
    }

    // independent + dependent steps: executor respects dependsOn ordering
    const plan = createPlanShell("ordering", [
        step("c", "Third", { tool: "t.c", dependsOn: ["b"] }),
        step("a", "First", { tool: "t.a" }),
        step("b", "Second", { tool: "t.b", dependsOn: ["a"] }),
    ]);
    const result = await new PlanExecutor(registry).execute(plan);
    assert.deepEqual(order, ["t.a", "t.b", "t.c"], `execution order: ${order.join(",")}`);
    assert.equal(result.status, "completed");
    assert.ok(result.steps.every(s => s.status === "completed"));
    assert.equal(plan.status, "completed");
    ok("executor: runs steps in dependency order regardless of declaration order");

    // failing step => dependents skipped, plan failed, failure surfaced
    const failing = new ToolRegistry();
    failing.register({
        name: "t.boom",
        description: "always fails",
        requiredArgs: ["x"],
        async executor() { throw new Error("tool exploded"); },
    });
    failing.register({
        name: "t.next",
        description: "never runs",
        async executor() { throw new Error("should not run"); },
    });
    const failingPlan = createPlanShell("failure", [
        step("boom", "Explode", { tool: "t.boom", args: { x: 1 } }),
        step("next", "After", { tool: "t.next", dependsOn: ["boom"] }),
    ]);
    const failingResult = await new PlanExecutor(failing).execute(failingPlan);
    assert.equal(failingResult.status, "failed");
    assert.equal(failingResult.steps[0]?.status, "failed");
    assert.match(String(failingResult.steps[0]?.error), /tool exploded/);
    assert.equal(failingResult.steps[1]?.status, "skipped");
    assert.equal(failingPlan.steps[1]?.status, "failed", "skipped step is marked failed on the plan");
    ok("executor: tool failure marks the step failed and skips dependents");

    // unknown tool referenced by a plan (validation bypassed) fails safely
    const unknownToolPlan = createPlanShell("unknown", [step("x", "Use missing tool", { tool: "nope.missing" })]);
    const unknownResult = await new PlanExecutor(registry).execute(unknownToolPlan);
    assert.equal(unknownResult.status, "failed");
    assert.match(String(unknownResult.steps[0]?.error), /unknown tool/);
    ok("executor: unknown tool fails the step instead of throwing out of control");

    // kind-tagged steps use the right hook per kind; progress hook fires per step
    const seen: string[] = [];
    const kindsHit: string[] = [];
    const exec = new PlanExecutor(registry, {
        runDecisionStep: async s => { kindsHit.push(`decision:${s.id}`); return { decided: s.goal }; },
        runActionStep: async s => { kindsHit.push(`action:${s.id}`); return { acted: s.goal }; },
        runResponseStep: async s => { kindsHit.push(`response:${s.id}`); return { awaitingLlm: true, about: s.goal }; },
        onStep: r => seen.push(`${r.stepId}:${r.status}`),
    });
    const reasoningPlan = createPlanShell("reasoning", [
        step("think", "Think it over", { kind: "decision" }),
        step("act", "Do the thing", { kind: "action", dependsOn: ["think"] }),
        step("respond", "Respond to the user", { kind: "response", dependsOn: ["act"] }),
    ]);
    const reasoningResult = await exec.execute(reasoningPlan);
    assert.equal(reasoningResult.status, "completed");
    assert.deepEqual(seen, ["think:completed", "act:completed", "respond:completed"]);
    assert.deepEqual(kindsHit, ["decision:think", "action:act", "response:respond"]);
    assert.deepEqual(reasoningResult.steps[0]?.output, { decided: "Think it over" });
    assert.equal(reasoningResult.steps[0]?.kind, "decision");
    assert.equal(reasoningResult.steps[2]?.kind, "response");
    ok("executor: kind-tagged steps dispatch to decision/action/response hooks");

    // default (no hooks) never fabricates agent/LLM reasoning
    const bare = await new PlanExecutor(registry).execute(
        createPlanShell("bare", [step("d", "Decide something", { kind: "decision" }), step("r", "Respond now", { kind: "response", dependsOn: ["d"] })]),
    );
    assert.deepEqual(bare.steps[0]?.output, { decisionStep: true, decided: "Decide something" });
    assert.deepEqual(bare.steps[1]?.output, { responseStep: true, awaitingLlm: true, about: "Respond now" });
    ok("executor: defaults tag planner vs LLM reasoning without inventing output");

    // kind inference: tool → "tool", respond/report goal → "response", else "decision"
    const inferred = await new PlanExecutor(registry).execute(createPlanShell("infer", [
        step("t", "Fetch data", { tool: "t.a" }),
        step("r", "Report the outcome to the user", { dependsOn: ["t"] }),
        step("d", "Filter candidates", { dependsOn: ["r"] }),
    ]));
    assert.deepEqual(inferred.steps.map(s => s.kind), ["tool", "response", "decision"]);
    ok("executor: resolveStepKind infers kind when the plan omits it");

    // summarizeExecution feeds the [Execution] section
    const bullets = summarizeExecution(result);
    assert.ok(bullets.some(b => b.includes("done (tool \"t.a\")")), bullets.join(" | "));
    ok("executor: summarizeExecution produces execution bullets with kinds/tools");

    // formatPlanResult is LLM-friendly and kind-tagged
    const text = formatPlanResult(result);
    assert.ok(text.includes("Plan ") && text.includes("goal: ordering") && text.includes("[tool/completed] a"), text);
    ok("executor: formatPlanResult renders kind-tagged plan results");
}


// ---------------------------------------------------------------------------
// 6. Agent E2E: Intent(task) → Planner → Executor → Results → System Prompt
// ---------------------------------------------------------------------------
{
    const responder: AgentResponder = async () => JSON.stringify({ step: "output", content: "ok" });

    let captured = "";
    const capturingResponder: AgentResponder = async messages => {
        const sys = messages.find(m => m.role === "system");
        if (sys) captured = sys.content;
        return JSON.stringify({ step: "output", content: "ok" });
    };

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(capturingResponder)
        .build();

    // --- TASK: plan is created, executed, and rendered into the dynamic context
    await agent.run("I need to buy a coffee machine, can you recommend one?");
    assert.equal(agent.getLastIntent()?.type, "task");
    const plan = agent.getLastPlan();
    const planResult = agent.getLastPlanResult();
    assert.ok(plan, "task turn must produce an IPlan");
    assert.equal(plan.status, "completed");
    assert.ok((plan.steps.length ?? 0) >= 3, "plan has steps");
    assert.ok(planResult && planResult.status === "completed", "plan executed successfully");
    assert.ok(captured.includes("[Current task]"), "dynamic context has a Current task section");
    assert.ok(captured.includes("[Execution]"), "dynamic context has an Execution section");
    assert.ok(captured.includes(`Goal: ${plan.goal}`), "task goal injected");
    assert.ok(captured.includes(plan.id), "injected text references the plan id");
    assert.ok(captured.includes("[Instruction]"), "dynamic context ends with an instruction section");
    assert.ok(captured.includes("never invent tool output"), "LLM told not to fabricate execution");
    ok("agent E2E: task → plan → execute → labelled dynamic context in system prompt");

    // --- QUESTION: untouched retrieval path, still gets [Relevant memory]
    await agent.run("What is the weather in Pune?");
    assert.equal(agent.getLastIntent()?.type, "question");
    assert.equal(agent.getLastPlan(), null, "questions never plan");
    assert.equal(agent.getLastPlanResult(), null);
    assert.ok(!captured.includes("[Execution]"), "no Execution section for questions");
    ok("agent E2E: question keeps the retrieval path with no planning");

    // --- CONVERSATION (your conflict case): memory path, no plan
    await agent.run("Actually, I like coffee now.");
    const convIntent = agent.getLastIntent();
    assert.equal(convIntent?.type, "conversation");
    assert.ok(convIntent?.signals.includes("correction"));
    assert.equal(agent.getLastPlan(), null, "conversation never plans");
    assert.equal(agent.getLastPlanResult(), null);
    ok("agent E2E: conversation/correction never plans (ConflictDetector path preserved)");

    // --- injected planner + registry are used verbatim
    const customRegistry = new ToolRegistry();
    const ran: string[] = [];
    customRegistry.register({
        name: "notes.save",
        description: "save a note",
        requiredArgs: ["text"],
        async executor(args) { ran.push(String(args["text"])); return { saved: true }; },
    });
    const customPlanner = new Planner({
        knownTools: customRegistry.names(),
        generatePlan: async () => JSON.stringify({
            goal: "note",
            steps: [{ id: "save", goal: "Save the note", tool: "notes.save", args: { text: "buy coffee" } }],
        }),
    });
    const customAgent = Agent.builder()
        .setInstructions("test")
        .withResponder(responder)
        .withToolRegistry(customRegistry)
        .withPlanner(customPlanner)
        .build();
    await customAgent.run("Create a note about coffee");
    assert.equal(customAgent.getLastIntent()?.type, "task");
    assert.deepEqual(customAgent.getLastPlan()?.steps.map(s => s.id), ["save"]);
    assert.deepEqual(ran, ["buy coffee"], "injected registry tool actually executed");
    assert.equal(customAgent.getToolRegistry().names().includes("notes.save"), true);
    ok("agent E2E: withPlanner/withToolRegistry seams drive real execution");
}

// ---------------------------------------------------------------------------
// 7. Dynamic Context — Memory Engine + Planning Engine as labelled sections
// ---------------------------------------------------------------------------
{
    const intent = detectIntent("Create a reminder for gym at 7am");

    // Memory Engine alone (question/conversation turns) → only [Relevant memory]
    const memoryOnly = buildDynamicContext({ runningContext: "ravi LIKES coffee", intent: null });
    assert.ok(memoryOnly?.includes("[Relevant memory]"));
    assert.ok(memoryOnly?.includes("- ravi LIKES coffee"), memoryOnly ?? "");
    assert.ok(!memoryOnly?.includes("[Execution]"));
    ok("dynamic context: memory engine output is labelled [Relevant memory]");

    // Planning Engine adds [Current task] + [Execution] + [Instruction]
    const registry = createDefaultToolRegistry();
    const planned = createPlanShell("Find a coffee machine", [
        step("search", "Search for coffee machines", { kind: "tool", tool: "web.search", args: { query: "coffee machine" } }),
        step("filter", "Filter to three candidates", { kind: "decision", dependsOn: ["search"] }),
        step("respond", "Generate the recommendation", { kind: "response", dependsOn: ["filter"] }),
    ]);
    const execution = await new PlanExecutor(registry).execute(planned);

    const full = buildDynamicContext({
        runningContext: "ravi LIKES coffee",
        intent,
        plan: planned,
        execution,
        planningNote: null,
    });
    assert.ok(full, "full context must exist");
    assert.ok(full.includes("[Relevant memory]"), "memory section present");
    assert.ok(full.includes("[Current task]"), "task section present");
    assert.ok(full.includes("Goal: Find a coffee machine"), "task goal present");
    assert.ok(full.includes("[Execution]"), "execution section present");
    assert.ok(full.includes("Search for coffee machines — done (tool \"web.search\")"), full);
    assert.ok(full.includes("Plan outcome: completed"), "plan outcome present");
    assert.ok(full.includes("[Instruction]"), "instruction section present");
    assert.ok(full.includes("never invent tool output"), "instruction forbids fabrication");
    // section order: memory → task → execution → instruction
    assert.ok(
        full.indexOf("[Relevant memory]") < full.indexOf("[Current task]")
        && full.indexOf("[Current task]") < full.indexOf("[Execution]")
        && full.indexOf("[Execution]") < full.indexOf("[Instruction]"),
        full,
    );
    ok("dynamic context: memory → task → execution → instruction sections in order");

    // Planning note (no plan) is surfaced so the LLM asks instead of guessing
    const noteOnly = buildDynamicContext({
        runningContext: null,
        intent,
        plan: null,
        execution: null,
        planningNote: "The task could not be planned automatically.",
    });
    assert.ok(noteOnly?.includes("[Current task]"));
    assert.ok(noteOnly?.includes("could not be planned automatically"));
    assert.ok(!noteOnly?.includes("[Execution]"), "no execution section without an execution");
    ok("dynamic context: unplanned tasks surface a clarification note, never an Execution section");

    // Nothing at all → null (caller falls back to bare instructions)
    assert.equal(buildDynamicContext({}), null);
    assert.equal(buildDynamicContext({ runningContext: "   ", intent: null }), null);
    ok("dynamic context: returns null when there is nothing to inject");
}

console.log(`\n✅ Planning Engine: ${pass} checks passed.`);
