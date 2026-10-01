// Phase 4E — Memory Extraction test (no Neo4j, no OpenAI, no network).
// Matrix: candidate boundary, tool/action/decision extraction, upstream
// exclusions, provenance, no-fabrication, confidence, determinism, and the
// no-persistence boundary (no Neo4j / ConflictDetector / FeedbackEngine).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { IMemoryCandidate } from "../app/execution/executionResultTypes.js";
import { createExecutionResultProcessor } from "../app/execution/executionResultProcessor.js";
import { CALENDAR_LIST_EVENTS_TOOL } from "../app/memory/memoryExtractor.js";
import { createDeterministicMemoryExtractor } from "../app/memory/deterministicMemoryExtractor.js";
import { PlanExecutor } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import { createDefaultActionRegistry } from "../app/action/defaultActions.js";

console.log(`
=================================================
MEMORY EXTRACTION TEST (Phase 4E)
IMemoryCandidate -> ICandidateMemoryExtractor -> IMemoryFact[]
(no Neo4j, no ConflictDetector, no FeedbackEngine)
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

/** Hand-built candidate for rule tests (no execution needed). */
function candidate(partial: Partial<IMemoryCandidate> & { content: unknown }): IMemoryCandidate {
    return {
        source: "execution",
        planId: "plan-x",
        stepId: "step-x",
        kind: "tool",
        goal: "test goal",
        ...partial,
    };
}

// ---------------------------------------------------------------------------
// 1-2. Candidate accepted + tool extraction (4E.1 / 4E.5)
// ---------------------------------------------------------------------------
{
    const extractor = createDeterministicMemoryExtractor();
    const events = [
        { title: "Team standup", time: "09:00" },
        { title: "Design review", time: "15:00" },
    ];
    const input = candidate({ tool: CALENDAR_LIST_EVENTS_TOOL, stepId: "get-events", content: events });

    // 4E.1: the interface accepts ONLY a candidate (never the execution result).
    assert.ok(!("steps" in input), "candidate carries no execution steps");
    assert.ok(!("args" in input), "candidate carries no args");

    const extraction = await extractor.extract(input);
    // 4E.2: output shape
    assert.equal(extraction.source, "execution");
    assert.equal(extraction.planId, "plan-x");
    assert.equal(extraction.stepId, "get-events");
    assert.deepEqual(extraction.rawCandidate.content, events, "structured output preserved");
    ok("candidate accepted: extraction record carries planId/stepId + raw structured output");

    // 4E.5: calendar.list_events → observation facts from OUTPUT
    assert.equal(extraction.facts.length, 4, "two events × (HAS_EVENT + OCCURS_AT)");
    const standup = extraction.facts.find(f => f.predicate === "HAS_EVENT" && f.object === "Team standup");
    assert.ok(standup, "Team standup fact extracted");
    assert.equal(standup.subject, "user");
    assert.equal(standup.tool, CALENDAR_LIST_EVENTS_TOOL, "tool provenance preserved");
    assert.equal(standup.kind, "tool");
    const at = extraction.facts.find(f => f.predicate === "OCCURS_AT" && f.object === "09:00");
    assert.ok(at, "occurs-at fact extracted");
    assert.equal(at.subject, "Team standup");
    ok("tool extraction: calendar.list_events → HAS_EVENT / OCCURS_AT facts");

    // 4E.5 guard: tool args must not leak — args are not even on a candidate.
    assert.ok(!extraction.facts.some(f => f.object === "tomorrow"), "args never become facts");
    ok("args not converted to facts (args are absent from the candidate boundary)");
}

// ---------------------------------------------------------------------------
// 3. Action extraction: explicit semantic output only (4E.6 / 4E.4)
// ---------------------------------------------------------------------------
{
    const extractor = createDeterministicMemoryExtractor();

    // Explicit semantic action output → passthrough rule fires.
    const semantic = candidate({
        kind: "action", action: "preference.record", stepId: "record-pref",
        content: { subject: "ravi", predicate: "PREFERS", object: "tea" },
    });
    const out = await extractor.extract(semantic);
    assert.equal(out.facts.length, 1, "explicit triple output → one fact");
    const fact = out.facts[0]!;
    assert.equal(fact.subject, "ravi");
    assert.equal(fact.predicate, "PREFERS");
    assert.equal(fact.object, "tea");
    assert.equal(fact.kind, "action");
    assert.equal(fact.action, "preference.record", "action provenance preserved");
    assert.equal(fact.tool, undefined);
    assert.equal(fact.planId, "plan-x");
    assert.equal(fact.stepId, "record-pref");
    ok("action extraction: explicit triple output → fact with action provenance");

    // list.pick → structured output must NOT become preference/fact (4E.6).
    const picked = candidate({
        kind: "action", action: "list.pick", stepId: "pick",
        content: { picked: ["BuildForms", "KnowStack", "Poll Platform"] },
    });
    const pickOut = await extractor.extract(picked);
    assert.deepEqual(pickOut.facts, [], "a pick is not a preference");
    assert.deepEqual(pickOut.rawCandidate.content, { picked: ["BuildForms", "KnowStack", "Poll Platform"] });
    ok("action extraction: list.pick output stays a candidate, zero fabricated facts");
}

// ---------------------------------------------------------------------------
// 4-6. Decision handling + upstream exclusions + no fabrication (4E.7 / 4E.9)
// ---------------------------------------------------------------------------
{
    const extractor = createDeterministicMemoryExtractor();

    // 4E.7: decisions stay conservative — preserved upstream, no invented fact.
    const decision = candidate({
        kind: "decision", stepId: "decide",
        content: { decided: "choose BuildForms because it satisfies the requirement" },
    });
    const decisionOut = await extractor.extract(decision);
    assert.deepEqual(decisionOut.facts, [], "a decision is not a user fact");
    assert.equal(decisionOut.rawCandidate.kind, "decision", "kind preserved for later conflict/feedback");
    ok("decision extraction: conservative — no 'user LIKES BuildForms' invented");

    // 4E.9 upstream: response / failed never become candidates, so never extracted.
    const processor = createExecutionResultProcessor();
    const upstream = processor.process({
        planId: "plan-up", goal: "g", status: "failed",
        startedAt: "2026-09-30T10:00:00.000Z", finishedAt: "2026-09-30T10:00:01.000Z",
        steps: [
            { stepId: "respond", goal: "g", kind: "response", status: "completed", output: { awaitingLlm: true } },
            { stepId: "send", goal: "g", kind: "tool", tool: "gmail.send", status: "failed", error: "tool policy confirm" },
            { stepId: "skip", goal: "g", kind: "action", action: "list.pick", status: "skipped" },
            { stepId: "ok", goal: "g", kind: "action", action: "list.pick", status: "completed", output: { picked: ["A"] } },
        ],
    });
    assert.deepEqual(upstream.map(c => c.stepId), ["ok"], "only the completed action with output is eligible");
    const extracted = await extractor.extract(upstream[0]!);
    assert.deepEqual(extracted.facts, [], "eligible but structurally non-semantic → no facts");
    ok("upstream: response/failed/skipped excluded by 4D before 4E ever sees them");

    // 4E.4: structured output does not automatically equal memory.
    const search = candidate({ tool: "web.search", content: { query: "coffee", results: ["a", "b"] } });
    const summarize = candidate({ kind: "action", action: "text.summarize_local", content: { summary: "alpha" } });
    assert.deepEqual((await extractor.extract(search)).facts, [], "search results are references, not user facts");
    assert.deepEqual((await extractor.extract(summarize)).facts, [], "a summary is not a fact");
    ok("no fabrication: web.search + summarize outputs yield zero facts");

    // custom rules CAN extend semantics explicitly (future providers).
    const custom = createDeterministicMemoryExtractor();
    assert.ok(custom.ruleIds().includes("tool.calendar.list_events"), "rule ids are introspectable");
    ok("deterministic: extractor exposes its rule ids (no hidden behaviour)");
}

// ---------------------------------------------------------------------------
// 4E.8 Confidence is introduced at the extraction layer (not 4D)
// ---------------------------------------------------------------------------
{
    const extractor = createDeterministicMemoryExtractor();
    const out = await extractor.extract(candidate({
        tool: CALENDAR_LIST_EVENTS_TOOL,
        content: [{ title: "Team standup", time: "09:00" }],
    }));
    assert.ok(out.facts.length >= 1);
    for (const fact of out.facts) {
        assert.equal(typeof fact.confidence, "number", "confidence is required (4E.8)");
        assert.ok(Number.isFinite(fact.confidence), "confidence is finite");
        assert.ok(fact.confidence > 0 && fact.confidence <= 1, `confidence in (0,1]: ${fact.confidence}`);
    }
    // Deterministic values, not randomness.
    assert.equal(out.facts.find(f => f.predicate === "HAS_EVENT")?.confidence, 0.7);
    assert.equal(out.facts.find(f => f.predicate === "OCCURS_AT")?.confidence, 0.6);

    // 4D produced NO confidence — it stays structural/deterministic.
    const processor = createExecutionResultProcessor();
    const cand = processor.process({
        planId: "p", goal: "g", status: "completed",
        startedAt: "2026-09-30T10:00:00.000Z", finishedAt: "2026-09-30T10:00:01.000Z",
        steps: [{ stepId: "s", goal: "g", kind: "tool", tool: "web.search", status: "completed", output: { results: [] } }],
    })[0]!;
    assert.ok(!("confidence" in cand), "candidates carry no confidence");
    ok("confidence: extraction-layer only, deterministic, absent from 4D candidates");
}

// ---------------------------------------------------------------------------
// 4E.4 determinism: same input → identical output, every time
// ---------------------------------------------------------------------------
{
    const input = candidate({
        tool: CALENDAR_LIST_EVENTS_TOOL,
        planId: "plan-det",
        content: [{ title: "Standup", time: "09:00" }],
    });
    const a = await createDeterministicMemoryExtractor().extract(input);
    const b = await createDeterministicMemoryExtractor().extract(input);
    assert.deepEqual(a, b, "deterministic extractor is reproducible");
    assert.deepEqual(a.facts, b.facts);
    // Rule order is stable and de-dup works.
    const dup = candidate({
        tool: CALENDAR_LIST_EVENTS_TOOL,
        content: [{ title: "Standup", time: "09:00" }, { title: "Standup", time: "09:00" }],
    });
    const dedup = await createDeterministicMemoryExtractor().extract(dup);
    assert.equal(dedup.facts.length, 2, "duplicate identical triples are collapsed");
    ok("deterministic: identical input → identical facts; de-duplication applied");
}

// ---------------------------------------------------------------------------
// 4E.9 / 4E.10: NO persistence boundary — no Neo4j / ConflictDetector /
// FeedbackEngine — and no widening of the input surface.
// ---------------------------------------------------------------------------
{
    const stripComments = (source: string): string =>
        source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    const files = [
        "../app/memory/extractionTypes.ts",
        "../app/memory/memoryExtractor.ts",
        "../app/memory/deterministicMemoryExtractor.ts",
    ];
    const forbidden = [
        "neo4j", "Neo4j", "neo4j-driver",
        "MemoryStore", "graphStore", "saveExtraction",
        "ConflictDetector", "conflictDetector", "detectConflicts",
        "FeedbackEngine", "feedbackEngine", "decideFeedback",
        "openai", "OpenAI",
        // input-surface widening (4E.1): the extractor must not see these
        "IPlanExecutionResult", "IStepResult", "ToolRegistry", "ActionRegistry",
        "planExecutor", "toolRegistry", "actionRegistry",
    ];
    for (const relative of files) {
        const raw = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
        const code = stripComments(raw);
        for (const term of forbidden) {
            assert.ok(!code.includes(term), `${relative} must not reference ${term}`);
        }
        assert.ok(raw.includes("Neo4j"), `${relative} should document the Neo4j boundary`);
    }
    ok("boundary: no Neo4j / ConflictDetector / FeedbackEngine / registries in 4E code");

    // The extractor's ONLY dependency is the candidate type.
    const typesCode = stripComments(readFileSync(
        fileURLToPath(new URL("../app/memory/extractionTypes.ts", import.meta.url)), "utf8"));
    assert.ok(typesCode.includes("IMemoryCandidate"), "input type is IMemoryCandidate");
    assert.ok(!typesCode.includes("IPlanExecutionResult"), "never the execution result");
    ok("input boundary (4E.1): extractor operates on IMemoryCandidate only");
}

// ---------------------------------------------------------------------------
// 4E.10 E2E: real execution → candidates → facts (no persistence anywhere)
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    tools.register({
        name: CALENDAR_LIST_EVENTS_TOOL,
        description: "list events",
        requiredArgs: ["date"],
        async executor() { return [{ title: "Team standup", time: "09:00" }]; },
    });
    const actions = createDefaultActionRegistry();
    const executor = new PlanExecutor(tools, { actions });

    // Real execution WITH args, so we can prove args never reach the facts.
    const result = await executor.execute(createPlanShell("4e e2e", [
        step("get-events", "Retrieve tomorrow's calendar events", {
            kind: "tool", tool: CALENDAR_LIST_EVENTS_TOOL, args: { date: "tomorrow" },
        }),
    ]));

    // 4D
    const candidates = createExecutionResultProcessor().process(result);
    assert.equal(candidates.length, 1);
    const cand = candidates[0]!;
    assert.equal(cand.tool, CALENDAR_LIST_EVENTS_TOOL);
    assert.ok(!("args" in cand), "candidate boundary strips args");

    // 4E
    const extraction = await createDeterministicMemoryExtractor().extract(cand);
    assert.ok(extraction.facts.length >= 1, "facts extracted from the real execution");
    const fact = extraction.facts.find(f => f.predicate === "HAS_EVENT");
    assert.ok(fact);
    assert.equal(fact.planId, result.planId, "planId flows through the whole chain");
    assert.equal(fact.stepId, "get-events");
    assert.equal(fact.tool, CALENDAR_LIST_EVENTS_TOOL);
    assert.equal(fact.source, "execution");
    assert.ok(!extraction.facts.some(f => f.object.includes("tomorrow")), "args (date=tomorrow) never become facts");

    // 4E.9: nothing in this chain persisted. The extractor holds no store.
    const extractorInstance = createDeterministicMemoryExtractor();
    assert.equal(
        Object.prototype.hasOwnProperty.call(extractorInstance, "memoryStore"),
        false,
        "extractor holds no memory store",
    );
    ok("E2E: execution → candidates → facts with full provenance, zero persistence");
}

console.log(`\n✅ Memory Extraction (4E): ${pass} checks passed.`);

