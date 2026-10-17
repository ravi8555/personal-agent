// Phase 4H — Agent ↔ execution-memory loop test (unit: fakes, no Neo4j/OpenAI).
//
// Chain under test, wired INSIDE Agent.run() at the integration point right
// after PlanExecutor.execute():
//
//   IPlanExecutionResult → (4D) candidates → (4E) facts → (4F/4G) pipeline
//   → graph changed? → running-context REFRESH → LLM
//
// Boundaries under test:
//   • Opt-in: no injected pipeline → behavior identical to pre-4H.
//   • Only plan-execution results enter the chain — conversation turns stay on
//     the legacy MemoryScheduler path (nothing duplicated or replaced).
//   • Failures are isolated: the user's turn always gets a response.
//   • Refresh happens ONLY when the pipeline changed graph state.
import assert from "node:assert/strict";

import { Agent } from "../app/agent.js";
import type { AgentResponder } from "../app/agent.js";
import { Planner } from "../app/planner.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import type { KnowledgeRetriever } from "../app/contextWatcher.js";
import type { IMemoryFact } from "../app/memory/extractionTypes.js";
import { CALENDAR_LIST_EVENTS_TOOL } from "../app/memory/memoryExtractor.js";
import type { IMemoryPipeline, IMemoryPipelineResult } from "../app/memoryPipeline/memoryPipelineTypes.js";
import type { IRelevantKnowledge } from "../app/graphRetrieval.js";
import { MemoryPipelineError } from "../app/memoryPipeline/memoryPipelineError.js";
import type { IRunningContext } from "../app/runningContext.js";

console.log(`
=================================================
AGENT MEMORY LOOP TEST (Phase 4H)
execute → 4D candidates → 4E facts → 4F/4G pipeline
         → refresh (when graph changed) → LLM
Opt-in; conversation stays on the legacy path.
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log('  PASS ' + label); pass++; };

/** Recording 4F/4G double — captures every batch the Agent hands it. */
function recordingPipeline(options: {
    tally?: Partial<IMemoryPipelineResult>;
    onProcess?: () => void;
} = {}): IMemoryPipeline & { calls: IMemoryFact[][] } {
    const calls: IMemoryFact[][] = [];
    return {
        calls,
        async process(facts: IMemoryFact[]): Promise<IMemoryPipelineResult> {
            calls.push(facts.map(f => ({ ...f })));
            options.onProcess?.();
            return {
                received: facts.length,
                normalized: facts.length,
                persisted: facts.length,
                conflicts: 0,
                rejected: 0,
                corrected: 0,
                ...options.tally,
            };
        },
    };
}

/** A pipeline that blows up like a Neo4j outage. */
function failingPipeline(): IMemoryPipeline {
    return {
        async process(): Promise<IMemoryPipelineResult> {
            throw new Error("neo4j down");
        },
    };
}

/** Registry with a fact-producing calendar tool + a tool that always throws. */
function calendarRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
        name: CALENDAR_LIST_EVENTS_TOOL,
        description: "list events",
        requiredArgs: ["date"],
        async executor() { return [{ title: "Dentist appointment", time: "10:00" }]; },
    });
    registry.register({
        name: "web.search",
        description: "search",
        requiredArgs: ["query"],
        async executor() { throw new Error("search backend down"); },
    });
    return registry;
}

/** Deterministic planner: fixed plan JSON, no network. Tools are declared so
 *  plan validation accepts them (same pattern as the MCP E2E planner). */
function plannerWith(steps: ReadonlyArray<Record<string, unknown>>): Planner {
    return new Planner({
        knownTools: () => [CALENDAR_LIST_EVENTS_TOOL, "web.search"],
        requiredArgs: () => ({
            [CALENDAR_LIST_EVENTS_TOOL]: ["date"],
            "web.search": ["query"],
        }),
        generatePlan: async () => JSON.stringify({ goal: "test task", steps }),
    });
}

/** Retriever double: counts calls, records order, swaps knowledge after refresh. */
function retrieverDouble(sequence: string[], freshText: string) {
    const knowledge = (text: string): IRelevantKnowledge => ({
        topicKey: "dentist",
        topicLabel: "Dentist",
        entityFound: true,
        relations: [],
        facts: [{ text, extractedAt: "2026-10-01T00:00:00.000Z" }],
        feedback: [],
        summaries: [],
    });
    // `calls` lives ON the retriever function too, so both
    // `const { retriever } = retrieverDouble(...)` and `retriever.calls` work.
    const retriever = Object.assign(
        async () => {
            retriever.calls++;
            sequence.push(`retriever:${retriever.calls}`);
            // Calls 1-2 = the initial build (watcher change-notification + direct
            // retrieval — pre-existing Phase B behavior); call 3+ = the 4H refresh.
            return knowledge(retriever.calls <= 2 ? "stale graph knowledge" : freshText);
        },
        { calls: 0 },
    );
    return { retriever, get calls() { return retriever.calls; } };
}

/** Responder double: captures the system prompt, records "llm" in order. */
function capturingResponder(sequence: string[]) {
    const state = { system: "" };
    const responder: AgentResponder = async messages => {
        const system = messages.find(m => m.role === "system");
        if (system) state.system = system.content;
        sequence.push("llm");
        return JSON.stringify({ step: "output", content: "ok" });
    };
    return { responder, state };
}

const TASK_QUERY = "Schedule a dentist appointment tomorrow";

// ---------------------------------------------------------------------------
// 1. Successful execution + fresh context (refresh AFTER graph change, BEFORE llm)
// ---------------------------------------------------------------------------
{
    const sequence: string[] = [];
    const { retriever } = retrieverDouble(sequence, "fresh graph: ravi HAS_EVENT dentist appointment");
    const pipeline = recordingPipeline({ onProcess: () => sequence.push("pipeline") });
    const { responder, state } = capturingResponder(sequence);

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withKnowledgeRetriever(retriever)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve tomorrow's calendar events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(pipeline)
        .build();

    const messages = await agent.run(TASK_QUERY);
    assert.ok(messages && messages.length > 0, "agent returned messages");

    assert.equal(agent.getLastIntent()?.type, "task");
    const result = agent.getLastPlanResult();
    assert.ok(result, "plan executed");
    assert.equal(result.status, "completed");

    // Composition: exactly one batch, execution-derived facts, real provenance.
    assert.equal(pipeline.calls.length, 1, "pipeline invoked exactly once");
    const facts = pipeline.calls[0]!;
    assert.ok(facts.length >= 1, "calendar output produced facts");
    assert.ok(
        facts.some(f => f.object.toLowerCase().includes("dentist appointment")),
        `facts derive from tool output: ${JSON.stringify(facts.map(f => f.subject + " " + f.predicate + " " + f.object))}`,
    );
    assert.ok(facts.every(f => f.source === "execution"), "execution provenance");
    assert.equal(facts[0]!.planId, result.planId, "planId provenance");
    assert.equal(facts[0]!.kind, "tool", "kind provenance");
    assert.ok(
        !facts.some(f => f.object.includes("Schedule a dentist")),
        "facts come from tool OUTPUT, never from the user message",
    );

    const tally = agent.getLastExecutionMemory();
    assert.ok(tally, "tally exposed");
    assert.equal(tally.persisted, facts.length, "persisted reported");

    // Refresh: graph changed → retriever ran again AFTER the chain. The initial
    // build fires it twice (watcher change-notification + direct retrieval —
    // pre-existing Phase B behavior); the 4H refresh adds exactly one more.
    assert.equal(retriever.calls, 3, "context refreshed after graph change");
    assert.deepEqual(
        sequence,
        ["retriever:1", "retriever:2", "pipeline", "retriever:3", "llm"],
        "order: context → execute/chain → refresh → llm",
    );

    // The LLM saw the FRESH knowledge, not the pre-execution snapshot.
    assert.ok(state.system.includes("fresh graph: ravi HAS_EVENT dentist appointment"), "refreshed knowledge injected");
    assert.ok(!state.system.includes("stale graph knowledge"), "stale snapshot replaced");
    assert.ok(state.system.includes(CALENDAR_LIST_EVENTS_TOOL), "[Execution] section rendered");
    ok("success: chain composed after execute; refreshed context reaches the LLM");
}

// ---------------------------------------------------------------------------
// 2. Failed / skipped steps → no eligible candidates → chain skipped
// ---------------------------------------------------------------------------
{
    const sequence: string[] = [];
    const { retriever } = retrieverDouble(sequence, "unused");
    const pipeline = recordingPipeline({ onProcess: () => sequence.push("pipeline") });
    const { responder } = capturingResponder(sequence);

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withKnowledgeRetriever(retriever)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            // web.search throws → failed; both dependents are skipped.
            { id: "search", goal: "Search the web", tool: "web.search", args: { query: "dentist" } },
            { id: "compare", goal: "Compare options", dependsOn: ["search"] },
            { id: "reply", goal: "Report the comparison", dependsOn: ["compare"] },
        ]))
        .withExecutionMemoryPipeline(pipeline)
        .build();

    const messages = await agent.run(TASK_QUERY);
    assert.ok(messages && messages.length > 0, "response still produced");

    const result = agent.getLastPlanResult();
    assert.ok(result, "execution result recorded");
    assert.equal(result.status, "failed", "tool step failed");
    assert.equal(result.steps.find(s => s.stepId === "search")?.status, "failed");
    assert.equal(result.steps.find(s => s.stepId === "compare")?.status, "skipped");
    assert.equal(result.steps.find(s => s.stepId === "reply")?.status, "skipped");

    assert.equal(pipeline.calls.length, 0, "failed/skipped steps → no candidates → chain skipped");
    assert.equal(agent.getLastExecutionMemory(), null, "no tally");
    assert.equal(agent.getLastExecutionMemoryState(), "unchanged", "chain evaluated → known no-op");
    assert.equal(retriever.calls, 2, "initial build only (change-notification + direct) — no refresh");
    assert.deepEqual(sequence, ["retriever:1", "retriever:2", "llm"], "order: context → llm (chain never ran)");
    ok("failed/skipped: chain skipped, no refresh, response unaffected");
}

// ---------------------------------------------------------------------------
// 3. Empty facts (action-only plan) and persisted=0 → short-circuit, no refresh
// ---------------------------------------------------------------------------
{
    // 3a: action output is non-semantic → candidate exists, zero facts.
    const seqA: string[] = [];
    const { retriever: rA } = retrieverDouble(seqA, "unused");
    const pipeA = recordingPipeline();
    const agentA = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(capturingResponder(seqA).responder)
        .withKnowledgeRetriever(rA)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "pick", goal: "Pick an option", kind: "action", action: "list.pick", args: { items: ["Alpha", "Beta"], count: 1 } },
        ]))
        .withExecutionMemoryPipeline(pipeA)
        .build();

    await agentA.run(TASK_QUERY);
    assert.equal(pipeA.calls.length, 0, "list.pick yields no facts → pipeline never invoked");
    assert.equal(agentA.getLastExecutionMemory(), null, "no tally");
    assert.equal(agentA.getLastExecutionMemoryState(), "unchanged", "chain evaluated → known no-op");
    assert.equal(rA.calls, 2, "initial build only — no refresh");
    ok("empty facts: non-semantic action output short-circuits before persistence");

    // 3b: facts exist but the pipeline persisted nothing (4F.9 gate) → no refresh.
    const seqB: string[] = [];
    const { retriever: rB } = retrieverDouble(seqB, "unused");
    const pipeB = recordingPipeline({ tally: { persisted: 0 } });
    const agentB = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(capturingResponder(seqB).responder)
        .withKnowledgeRetriever(rB)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(pipeB)
        .build();

    await agentB.run(TASK_QUERY);
    assert.equal(pipeB.calls.length, 1, "pipeline ran");
    assert.equal(agentB.getLastExecutionMemory()?.persisted, 0, "tally reports persisted=0");
    assert.equal(agentB.getLastExecutionMemoryState(), "unchanged", "persisted=0 → known no-op");
    assert.equal(rB.calls, 2, "persisted=0 → context NOT refreshed (initial build only)");
    ok("persisted=0: no graph change → refresh suppressed");
}

// ---------------------------------------------------------------------------
// 4. Persistence failure → isolated: response proceeds, pre-execution context kept
// ---------------------------------------------------------------------------
{
    const sequence: string[] = [];
    const { retriever } = retrieverDouble(sequence, "unused");
    const { responder, state } = capturingResponder(sequence);

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withKnowledgeRetriever(retriever)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(failingPipeline())
        .build();

    const messages = await agent.run(TASK_QUERY); // must NOT throw
    assert.ok(messages && messages.length > 0, "response produced despite pipeline outage");
    assert.equal(agent.getLastExecutionMemory(), null, "failure leaves no tally");
    assert.equal(retriever.calls, 2, "no refresh after failure — pre-execution context kept");
    assert.ok(state.system.length > 0, "LLM still received a system prompt");
    ok("persistence failure: isolated — response proceeds with pre-execution context");
}

// ---------------------------------------------------------------------------
// 5. Opt-in regression: NO pipeline seam → behavior identical to pre-4H
// ---------------------------------------------------------------------------
{
    const sequence: string[] = [];
    const { retriever } = retrieverDouble(sequence, "graph knowledge");
    const { responder, state } = capturingResponder(sequence);

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withKnowledgeRetriever(retriever)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        // deliberately NO .withExecutionMemoryPipeline(...)
        .build();

    const messages = await agent.run(TASK_QUERY);
    assert.ok(messages && messages.length > 0);
    assert.equal(agent.getLastExecutionMemory(), null, "chain never ran");
    assert.equal(agent.getLastExecutionMemoryState(), null, "no pipeline injected → chain never ran");
    assert.equal(retriever.calls, 2, "exactly one context build, no refresh (initial build = 2 calls)");
    assert.ok(state.system.includes(CALENDAR_LIST_EVENTS_TOOL), "[Execution] still rendered — today's behavior intact");
    assert.deepEqual(sequence, ["retriever:1", "retriever:2", "llm"]);
    ok("opt-in: without a pipeline, behavior identical to pre-4H");
}

// ---------------------------------------------------------------------------
// 6. Boundary: conversation turns stay on the LEGACY extraction path
// ---------------------------------------------------------------------------
{
    const sequence: string[] = [];
    const { retriever } = retrieverDouble(sequence, "unused");
    const pipeline = recordingPipeline();
    const { responder } = capturingResponder(sequence);

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withKnowledgeRetriever(retriever)
        .withExecutionMemoryPipeline(pipeline)
        .build();

    await agent.run("I prefer tea over coffee.");
    assert.equal(agent.getLastIntent()?.type, "conversation");
    assert.equal(agent.getLastPlan(), null, "conversation never plans");
    assert.equal(agent.getLastPlanResult(), null, "no execution result");
    assert.equal(pipeline.calls.length, 0, "execution chain untouched by conversation turns");
    assert.equal(agent.getLastExecutionMemory(), null);
    assert.equal(agent.getLastExecutionMemoryState(), null, "conversation turn → chain never ran");
    assert.equal(retriever.calls, 2, "initial build only");

    // The statement lands in short-term memory — the LEGACY scheduler's source.
    const users = agent.getMemoryProcessor().readByRole("user");
    assert.ok(
        users.some(m => m.content.includes("prefer tea over coffee")),
        "message recorded for the legacy MemoryScheduler path",
    );
    ok("conversation turn: legacy path owns it — execution chain never invoked");
}

// ---------------------------------------------------------------------------
// 7. 4I — partial-write hardening: tri-state outcome + refresh decisions
// ---------------------------------------------------------------------------
{
    // (a) Persistence SUCCEEDED, self-correction FAILED (typed error with
    //     graphMayHaveChanged=true) → refresh ATTEMPTED, response unaffected.
    const sequence: string[] = [];
    const { retriever } = retrieverDouble(sequence, "fresh graph after correction failure");
    const { responder, state } = capturingResponder(sequence);
    const correctionFailure: IMemoryPipeline = {
        async process(): Promise<IMemoryPipelineResult> {
            sequence.push("pipeline");
            throw new MemoryPipelineError("correction", new Error("neo4j died mid-correction"), 2);
        },
    };

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responder)
        .withKnowledgeRetriever(retriever)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(correctionFailure)
        .build();

    const messages = await agent.run(TASK_QUERY);
    assert.ok(messages && messages.length > 0, "response unaffected by the pipeline failure");
    assert.equal(agent.getLastExecutionMemory(), null, "no tally on failure");
    assert.equal(agent.getLastExecutionMemoryState(), "possibly-changed", "typed failure after a possible write");
    assert.equal(retriever.calls, 3, "refresh attempted despite the failure (2 initial + 1 refresh)");
    assert.ok(sequence.indexOf("pipeline") < sequence.indexOf("retriever:3"), "refresh follows the failed pipeline");
    assert.equal(sequence[sequence.length - 1], "llm", "LLM still answered");
    assert.ok(state.system.includes("fresh graph"), "refreshed knowledge reached the prompt");
    ok("4I: persist-then-correct failure → possibly-changed → refresh attempted");

    // (b) Persistence-stage failure (atomic rollback, nothing landed) → NO refresh.
    const sequenceB: string[] = [];
    const { retriever: retrieverB } = retrieverDouble(sequenceB, "unused");
    const { responder: responderB } = capturingResponder(sequenceB);
    const storeDown: IMemoryPipeline = {
        async process(): Promise<IMemoryPipelineResult> {
            sequenceB.push("pipeline");
            throw new MemoryPipelineError("persistence", new Error("neo4j down"), 0);
        },
    };
    const agentB = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responderB)
        .withKnowledgeRetriever(retrieverB)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(storeDown)
        .build();
    await agentB.run(TASK_QUERY);
    assert.equal(agentB.getLastExecutionMemoryState(), "unchanged", "atomic rollback → known unchanged");
    assert.equal(retrieverB.calls, 2, "no refresh without a graph change");
    assert.deepEqual(sequenceB, ["retriever:1", "retriever:2", "pipeline", "llm"]);
    ok("4I: persistence-stage failure → unchanged → no extra retrieval");

    // (c) Unknown (untyped) pipeline error → unchanged → NO refresh (pre-4H).
    const sequenceC: string[] = [];
    const { retriever: retrieverC } = retrieverDouble(sequenceC, "unused");
    const { responder: responderC } = capturingResponder(sequenceC);
    const agentC = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responderC)
        .withKnowledgeRetriever(retrieverC)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(failingPipeline())
        .build();
    await agentC.run(TASK_QUERY);
    assert.equal(agentC.getLastExecutionMemoryState(), "unchanged", "unknown failure → known no-op default");
    assert.equal(retrieverC.calls, 2, "no refresh after an unknown pipeline error");
    ok("4I: unknown pipeline errors stay 'unchanged' — pre-4H no-refresh guarantee");

    // (d) DELIBERATE decision: a legitimately NULL refresh keeps the previous
    //     snapshot (never blanks the prompt). Patch the public seam.
    const sequenceD: string[] = [];
    const pipelineD = recordingPipeline();
    const { responder: responderD, state: stateD } = capturingResponder(sequenceD);
    const agentD = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withResponder(responderD)
        .withToolRegistry(calendarRegistry())
        .withPlanner(plannerWith([
            { id: "get-events", goal: "Retrieve events", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" } },
        ]))
        .withExecutionMemoryPipeline(pipelineD)
        .build();
    let contextBuilds = 0;
    const preExecution: IRunningContext = {
        topic: { key: "dentist", label: "dentist appointment", evidence: ["dentist"] } as unknown as IRunningContext["topic"],
        knowledge: {} as IRelevantKnowledge,
        text: "pre-execution knowledge snapshot",
        evidence: [],
        historicalEvidence: [],
        latestEvidence: "",
    };
    agentD.buildRunningContext = async () => {
        contextBuilds++;
        return contextBuilds === 1 ? preExecution : null; // refresh legitimately null
    };
    await agentD.run(TASK_QUERY);
    assert.equal(contextBuilds, 2, "refresh attempted (state=changed)");
    assert.equal(agentD.getLastExecutionMemoryState(), "changed");
    assert.ok(
        stateD.system.includes("pre-execution knowledge snapshot"),
        "null refresh → old snapshot kept, never blanked",
    );
    ok("4I: null refreshed context keeps the pre-execution snapshot (deliberate)");
}

console.log(`\n✅ Agent Memory Loop (4H + 4I): ${pass} checks passed.`);
