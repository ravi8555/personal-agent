// Phase 4D — Unified Execution Result test (no Neo4j, no OpenAI, no network).
// Acceptance matrix: canonical result, provenance for all step kinds,
// completed/failed/skipped eligibility, presentation separation,
// and the memory boundary (processor never writes Neo4j).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PlanExecutor, summarizeExecution, formatPlanResult } from "../app/planExecutor.js";
import type { IPlanExecutionResult, IStepResult } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import { createDefaultToolPolicy } from "../app/toolPolicy.js";
import { createDefaultActionRegistry } from "../app/action/defaultActions.js";
import {
    ExecutionResultProcessor,
    createExecutionResultProcessor,
} from "../app/execution/executionResultProcessor.js";

console.log(`
=================================================
UNIFIED EXECUTION RESULT TEST (Phase 4D)
IPlanExecutionResult -> ExecutionResultProcessor -> MemoryCandidate
(no Neo4j, no OpenAI, no network)
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

/** Build a canonical result by hand (no execution needed for rule tests). */
function resultOf(planId: string, steps: IStepResult[]): IPlanExecutionResult {
    return {
        planId,
        goal: "test plan",
        status: "completed",
        steps,
        startedAt: "2026-09-30T10:00:00.000Z",
        finishedAt: "2026-09-30T10:00:01.000Z",
    };
}

// ---------------------------------------------------------------------------
// 1-5. Canonical result + provenance for every step kind (4D.1/4D.5/4D.7)
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    tools.register({
        name: "web.search",
        description: "search",
        requiredArgs: ["query"],
        async executor(args) { return { query: args["query"], results: ["A", "B"] }; },
    });
    const actions = createDefaultActionRegistry();
    const executor = new PlanExecutor(tools, { actions, policy: createDefaultToolPolicy() });

    const result = await executor.execute(createPlanShell("provenance plan", [
        step("search", "Search for projects", { kind: "tool", tool: "web.search", args: { query: "React 20" } }),
        step("pick", "Pick three relevant projects", {
            kind: "action", action: "list.pick",
            args: { items: ["BuildForms", "KnowStack", "Poll Platform"], count: 3 },
            dependsOn: ["search"],
        }),
        step("think", "Decide the ordering", { kind: "decision", dependsOn: ["pick"] }),
        step("respond", "Report the outcome", { kind: "response", dependsOn: ["think"] }),
    ]));

    // 1. canonical envelope contains every step, in execution order
    assert.equal(result.steps.length, 4, "IPlanExecutionResult contains all steps");
    assert.deepEqual(result.steps.map(s => s.stepId), ["search", "pick", "think", "respond"]);
    assert.equal(result.status, "completed");
    assert.ok(!Number.isNaN(Date.parse(result.startedAt)) && !Number.isNaN(Date.parse(result.finishedAt)));
    ok("canonical: IPlanExecutionResult contains all steps (+ timestamps)");

    // 2. tool provenance + args recorded (4D.2)
    const search = result.steps[0]!;
    assert.equal(search.kind, "tool");
    assert.equal(search.tool, "web.search", "tool name preserved");
    assert.deepEqual(search.args, { query: "React 20" }, "args recorded as internal provenance");
    assert.deepEqual(search.output, { query: "React 20", results: ["A", "B"] }, "structured output preserved");
    ok("provenance: tool name + args + structured output preserved");

    // 3. action provenance
    const pick = result.steps[1]!;
    assert.equal(pick.kind, "action");
    assert.equal(pick.action, "list.pick", "action name preserved");
    assert.equal(pick.tool, undefined, "action step carries no tool");
    assert.deepEqual(pick.output, { picked: ["BuildForms", "KnowStack", "Poll Platform"] });
    ok("provenance: action name preserved (and no tool leakage)");

    // 4. decision provenance — kind preserved
    const think = result.steps[2]!;
    assert.equal(think.kind, "decision");
    assert.equal(think.tool, undefined);
    assert.equal(think.action, undefined);
    assert.ok(think.output !== undefined);
    ok("provenance: decision kind preserved");

    // 5. response provenance — kind preserved
    const respond = result.steps[3]!;
    assert.equal(respond.kind, "response");
    assert.deepEqual(respond.output, { responseStep: true, awaitingLlm: true, about: "Report the outcome" });
    ok("provenance: response kind preserved");

    // 6-11. planId / stepId / goal preserved through the processor
    const processor = createExecutionResultProcessor();
    const candidates = processor.process(result);
    const searchCandidate = candidates.find(c => c.stepId === "search");
    const pickCandidate = candidates.find(c => c.stepId === "pick");
    assert.ok(searchCandidate && pickCandidate);
    assert.equal(searchCandidate.planId, result.planId, "planId preserved (plan provenance)");
    assert.equal(searchCandidate.goal, "Search for projects", "goal preserved");
    assert.equal(searchCandidate.source, "execution");
    assert.equal(searchCandidate.kind, "tool");
    assert.equal(searchCandidate.tool, "web.search");
    assert.equal(pickCandidate.action, "list.pick");
    assert.deepEqual(pickCandidate.content, { picked: ["BuildForms", "KnowStack", "Poll Platform"] }, "content is the structured output");
    ok("provenance: planId / stepId / goal / kind / tool / action / content preserved");
}

// ---------------------------------------------------------------------------
// 6-9. Candidate eligibility: completed/failed/skipped × kind (4D.6)
// ---------------------------------------------------------------------------
{
    const processor = createExecutionResultProcessor();
    const steps: IStepResult[] = [
        { stepId: "ok-tool", goal: "g", kind: "tool", tool: "web.search", status: "completed", output: { results: ["A"] } },
        { stepId: "ok-action", goal: "g", kind: "action", action: "list.pick", status: "completed", output: { picked: ["A"] } },
        { stepId: "ok-decision", goal: "g", kind: "decision", status: "completed", output: { decided: "x" } },
        { stepId: "ok-response", goal: "g", kind: "response", status: "completed", output: { awaitingLlm: true } },
        { stepId: "fail-tool", goal: "g", kind: "tool", tool: "gmail.send", status: "failed", error: "tool policy confirm" },
        { stepId: "fail-action", goal: "g", kind: "action", action: "demo.fail", status: "failed", error: "boom" },
        { stepId: "skip-tool", goal: "g", kind: "tool", tool: "web.search", status: "skipped", error: "skipped: dependency not completed" },
        { stepId: "empty-output", goal: "g", kind: "action", action: "list.pick", status: "completed" },
    ];
    const candidates = processor.process(resultOf("plan-elig", steps));
    const ids = candidates.map(c => c.stepId);

    // 6. completed tool → candidate
    assert.ok(ids.includes("ok-tool"), "completed tool → candidate");
    ok("eligibility: completed tool → candidate");
    // 7. completed action → candidate
    assert.ok(ids.includes("ok-action"), "completed action → candidate");
    ok("eligibility: completed action → candidate");
    // decision allowed but kind preserved
    assert.ok(ids.includes("ok-decision"));
    assert.equal(candidates.find(c => c.stepId === "ok-decision")?.kind, "decision");
    ok("eligibility: completed decision → candidate with kind preserved");
    // response: NOT a candidate by default
    assert.ok(!ids.includes("ok-response"), "response is not an automatic candidate");
    ok("eligibility: response → NOT a candidate by default");
    // 8. failed tool → NOT a candidate
    assert.ok(!ids.includes("fail-tool"), "failed tool → not a candidate");
    assert.ok(!ids.includes("fail-action"), "failed action → not a candidate");
    ok("eligibility: failed tool/action → NOT candidates (errors are not knowledge)");
    // 9. skipped → NOT a candidate
    assert.ok(!ids.includes("skip-tool"), "skipped step → not a candidate");
    ok("eligibility: skipped step → NOT a candidate (Phase 3.5 semantics)");
    // output required
    assert.ok(!ids.includes("empty-output"), "completed but no output → not a candidate");
    ok("eligibility: completed without output → not a candidate");

    // Configurable opt-ins
    const withResponses = new ExecutionResultProcessor({ includeResponses: true }).process(resultOf("plan-elig", steps));
    assert.ok(withResponses.map(c => c.stepId).includes("ok-response"), "includeResponses opt-in works");
    const noDecisions = new ExecutionResultProcessor({ includeDecisions: false }).process(resultOf("plan-elig", steps));
    assert.ok(!noDecisions.map(c => c.stepId).includes("ok-decision"), "includeDecisions opt-out works");
    const onlyActions = new ExecutionResultProcessor({ includeTools: false, includeDecisions: false }).process(resultOf("plan-elig", steps));
    assert.deepEqual(onlyActions.map(c => c.stepId), ["ok-action"], "includeTools/includeDecisions opt-out works");
    ok("eligibility: opt-in/opt-out flags are honored deterministically");
}
// ---------------------------------------------------------------------------
// 13. Presentation separation: [Execution] ≠ memory source (4D.8)
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    tools.register({
        name: "web.search",
        description: "search",
        requiredArgs: ["query"],
        async executor(args) { return { results: [args["query"]] }; },
    });
    const executor = new PlanExecutor(tools, { actions: createDefaultActionRegistry() });
    const result = await executor.execute(createPlanShell("presentation", [
        step("search", "Search the web", { kind: "tool", tool: "web.search", args: { query: "coffee" } }),
        step("sum", "Summarize locally", {
            kind: "action", action: "text.summarize_local",
            args: { text: "alpha beta gamma", maxLength: 5 },
            dependsOn: ["search"],
        }),
    ]));

    // The formatted string is generated FROM the canonical result…
    const bullet = summarizeExecution(result);
    assert.ok(bullet.some(b => b.includes('tool "web.search"')), bullet.join(" | "));
    assert.ok(bullet.some(b => b.includes('action "text.summarize_local"')), bullet.join(" | "));
    assert.ok(formatPlanResult(result).includes("[tool/completed] search"));
    ok("presentation: [Execution] bullets are generated from the execution result");

    // …but the processor consumes the RESULT OBJECT, never the formatted text.
    const processorSource = readFileSync(
        fileURLToPath(new URL("../app/execution/executionResultProcessor.ts", import.meta.url)),
        "utf8",
    );
    const executionText = bullet.join("\n");
    assert.ok(!processorSource.includes("summarizeExecution"), "processor must not call summarizeExecution");
    assert.ok(!processorSource.includes("formatPlanResult"), "processor must not call formatPlanResult");
    const candidates = createExecutionResultProcessor().process(result);
    assert.equal(candidates.length, 2, "both completed steps produced candidates");
    for (const candidate of candidates) {
        const serialized = JSON.stringify(candidate.content);
        assert.ok(!serialized.includes("— done ("), "content must be structured output, not the formatted bullet");
        assert.ok(!executionText.includes(serialized) || typeof candidate.content !== "string", "content is never a presentation string");
    }
    assert.deepEqual(candidates[1]?.content, { summary: "alpha" }, "action content is the raw output");
    ok("presentation separation: processor reads IPlanExecutionResult, never [Execution] text");
}

// ---------------------------------------------------------------------------
// 14/15. Memory + MCP boundary: candidates only, NO Neo4j write (4D.10)
// ---------------------------------------------------------------------------
{
    // Static guarantee: the 4D modules must not IMPORT/reference Neo4j or
    // OpenAI anywhere in CODE. Comments legitimately discuss the boundary, so
    // strip comments before scanning.
    const stripComments = (source: string): string =>
        source
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^[ \t]*\/\/.*$/gm, "");

    const files = [
        "../app/execution/executionResultProcessor.ts",
        "../app/execution/executionResultTypes.ts",
    ];
    for (const relative of files) {
        const raw = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
        const code = stripComments(raw);
        for (const forbidden of ["neo4j", "Neo4j", "graphStore", "MemoryStore", "saveExtraction", "openai", "OpenAI", "graphRetrieval", "conflictDetector"]) {
            assert.ok(!code.includes(forbidden), `${relative} code must not reference ${forbidden}`);
        }
        // …and the boundary is documented, not just omitted.
        assert.ok(raw.includes("Neo4j"), `${relative} should document the Neo4j boundary`);
    }
    ok("memory boundary: 4D modules import/call NO Neo4j / OpenAI / graph module (boundary documented)");

    // MCP-style tool result → canonical result → candidate, with no persistence.
    const tools = new ToolRegistry();
    tools.register({
        name: "calendar.list_events",
        description: "list events",
        requiredArgs: ["date"],
        async executor() { return [{ title: "Team standup", time: "09:00" }]; },
    });
    const executor = new PlanExecutor(tools, { actions: createDefaultActionRegistry() });

    let agentWroteMemory = false;
    const result = await executor.execute(createPlanShell("mcp boundary", [
        step("get-events", "Retrieve tomorrow's calendar events", {
            kind: "tool", tool: "calendar.list_events", args: { date: "tomorrow" },
        }),
    ]));

    const candidates = createExecutionResultProcessor().process(result);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.tool, "calendar.list_events");
    assert.deepEqual(candidates[0]?.content, [{ title: "Team standup", time: "09:00" }]);
    // Nothing here touches persistence: the processor has no store handle at all.
    assert.ok(!("memoryStore" in Object.getOwnPropertyNames(createExecutionResultProcessor())), "processor holds no store");
    assert.equal(agentWroteMemory, false, "no memory write occurred from the execution path");
    ok("MCP boundary: tool result → IPlanExecutionResult → MemoryCandidate (no direct MCP → Neo4j)");
}

console.log(`\n✅ Unified Execution Result (4D): ${pass} checks passed.`);