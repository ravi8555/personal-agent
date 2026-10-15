// Phase 4F — Memory Pipeline test.
// Unit portions need no Neo4j/OpenAI/network; the final CRITICAL E2E section
// uses the real Neo4j environment (requires NEO4J_* env vars).
//
// Chain under test:
//   IMemoryFact[] → normalize (Phase 3) → ConflictDetector (Phase 3) →
//   FeedbackEngine (Phase 3) → Neo4jMemoryStore (Phase 3)
// NEVER: fact → Neo4j directly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { IMemoryFact } from "../app/memory/extractionTypes.js";
import { createDeterministicMemoryExtractor } from "../app/memory/deterministicMemoryExtractor.js";
import { createExecutionResultProcessor } from "../app/execution/executionResultProcessor.js";
import { normalizeRelations, normalizeRelation } from "../app/graphNormalization.js";
import type { INormalizedRelation } from "../app/graphNormalization.js";
import { areOpposites } from "../app/conflictDetector.js";
import type { IConflictAnalysis, IConflictFinding } from "../app/conflictDetector.js";
import { SelfCorrectionEngine, createSelfCorrectionEngine, SELF_CORRECTION_RULES } from "../app/selfCorrection.js";
import type { IRetrievedRelation, IGraphQueryResult } from "../app/graphRetrieval.js";
import type { IMemoryExtraction } from "../app/memoryExtraction.js";
import { MemoryPipeline, createMemoryPipeline } from "../app/memoryPipeline/memoryPipeline.js";
import type { IMemoryFactStore } from "../app/memoryPipeline/memoryPipelineTypes.js";
import { factToRelation } from "../app/memoryPipeline/memoryFactNormalizer.js";
import { PlanExecutor } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import { createDefaultActionRegistry } from "../app/action/defaultActions.js";

console.log(`
=================================================
MEMORY PIPELINE TEST (Phase 4F + 4G)
IMemoryFact[] -> Normalize -> Conflict -> Feedback -> Persist -> Self-Correction -> Neo4j
4F: fact -> Neo4j ONLY after normalize/conflict/feedback.
4G: corrections DELEGATED to the EXISTING SelfCorrectionEngine (no 2nd engine).
(4D + 4E stay persistence-unaware)
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

/** Recording store double — captures every saveExtraction call. */
function recordingStore(): IMemoryFactStore & { calls: IMemoryExtraction[] } {
    return {
        calls: [],
        async saveExtraction(extraction: IMemoryExtraction) {
            this.calls.push(extraction);
        },
    };
}

/** Build an execution-sourced fact (4E output shape). */
function executionFact(partial: Partial<IMemoryFact> & Pick<IMemoryFact, "subject" | "predicate" | "object">): IMemoryFact {
    return {
        confidence: 0.7,
        source: "execution",
        planId: "plan-123",
        stepId: "step-1",
        kind: "tool",
        ...partial,
    };
}

// ---------------------------------------------------------------------------
// 1. 4F.1 boundary: the pipeline consumes IMemoryFact[] and nothing else
// ---------------------------------------------------------------------------
{
    const stripComments = (source: string): string =>
        source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    const files = [
        "../app/memoryPipeline/memoryPipelineTypes.ts",
        "../app/memoryPipeline/memoryFactNormalizer.ts",
        "../app/memoryPipeline/memoryPipeline.ts",
    ];
    const forbidden = [
        // execution-side inputs4F must never see (4F.1)
        "IPlanExecutionResult", "IStepResult", "IMemoryCandidate",
        "planExecutor", "executionResult", "ToolRegistry", "ActionRegistry",
        "toolRegistry", "actionRegistry",
    ];
    for (const relative of files) {
        const raw = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
        const code = stripComments(raw);
        for (const term of forbidden) {
            assert.ok(!code.includes(term), `${relative} must not reference ${term}`);
        }
        assert.ok(raw.includes("4F"), `${relative} should document the 4F boundary`);
    }
    ok("4F.1 boundary: pipeline takes IMemoryFact[] only (no execution/registry inputs)");
}

// ---------------------------------------------------------------------------
// 2. 4F.9 / 4F.10: zero facts → NO normalization, NO conflict, NO persistence
// ---------------------------------------------------------------------------
{
    const store = recordingStore();
    const pipeline = createMemoryPipeline({ store });

    const empty = await pipeline.process([]);
    assert.deepEqual(empty, { received: 0, normalized: 0, persisted: 0, conflicts: 0, rejected: 0, corrected: 0 });
    assert.equal(store.calls.length, 0, "zero facts must never reach the store");

    const allRejected = await pipeline.process([
        executionFact({ subject: "", predicate: "IS", object: "x" }),   // unusable subject
        executionFact({ subject: "user", predicate: "", object: "y" }),  // unusable predicate
    ]);
    assert.equal(allRejected.received, 2);
    assert.equal(allRejected.normalized, 0);
    assert.equal(allRejected.rejected, 2);
    assert.equal(allRejected.persisted, 0);
    assert.equal(store.calls.length, 0, "nothing normalizable → nothing persisted");
    ok("zero/unusable facts → no persistence (4F.9: IMemoryFact ≠ guaranteed write)");
}

// ---------------------------------------------------------------------------
// 3. 4F.3 fact enters pipeline → normalizes via Phase 3 (entityKey + predicate)
// ---------------------------------------------------------------------------
{
    const store = recordingStore();
    const pipeline = createMemoryPipeline({ store });

    const fact = executionFact({
        subject: "Ravi",
        predicate: "likes",
        object: "Coffee",
        tool: "memory.note",
    });
    const result = await pipeline.process([fact]);

    assert.equal(result.received, 1);
    assert.equal(result.normalized, 1);
    assert.equal(result.rejected, 0);

    const relations = pipeline.getLatestRelations();
    assert.equal(relations.length, 1);
    const relation = relations[0]!;
    // Phase 3 normalization applied: entityKey + canonical predicate.
    assert.equal(relation.subject, "ravi", "entityKey applied");
    assert.equal(relation.object, "coffee", "entityKey applied");
    assert.equal(relation.predicate, "LIKES", "canonical predicate applied");
    assert.equal(relation.canonicalPredicate, true);
    assert.equal(relation.confidence, 0.7);
    ok("normalization: fact → Phase 3 entityKey + canonical predicate (reused, not redesigned)");
}


// ---------------------------------------------------------------------------
// 4. 4F.4/4F.5/4F.6: delegation + ordering (conflict → feedback → store)
// ---------------------------------------------------------------------------
{
    const store = recordingStore();
    const order: string[] = [];
    let seen: { current: readonly INormalizedRelation[]; historical: readonly IRetrievedRelation[]; evidence?: readonly string[] } | null = null;

    const pipeline = createMemoryPipeline({
        store,
        historical: async subjects => [
            { subject: "ravi", predicate: "DISLIKES", object: "tea", confidence: 0.9 },
        ].filter(h => subjects.includes(h.subject)),
        // Existing Phase 3 conflict semantics: opposites conflict.
        detect: input => {
            order.push("detect");
            seen = input;
            const findings: IConflictFinding[] = [];
            for (const current of input.current) {
                const conflicting = input.historical.filter(h =>
                    h.subject === current.subject
                    && h.object === current.object
                    && areOpposites(current.predicate, h.predicate));
                if (conflicting.length > 0) {
                    findings.push({
                        subject: current.subject,
                        object: current.object,
                        current,
                        historical: conflicting,
                        explicitEvidence: (input.evidence ?? []).some(e => e.toLowerCase().includes(current.object)),
                    });
                }
            }
            return { conflict: findings.length > 0, findings };
        },
        // Existing Phase 3 feedback semantics.
        feedback: finding => {
            order.push("feedback");
            return finding.explicitEvidence
                ? { action: "SUPERSEDED", context: "supersede", reason: "explicit evidence" }
                : { action: "CONFLICTING", context: "keep both", reason: "no explicit evidence" };
        },
        now: () => "2026-09-30T10:00:00.000Z",
    });

    const result = await pipeline.process([
        executionFact({ subject: "Ravi", predicate: "PREFERS", object: "tea", tool: "memory.note" }),
    ]);

    // 4F.4: ConflictDetector received NORMALIZED facts + history + evidence.
    assert.ok(seen, "conflict detector invoked (delegated)");
    const input = seen as unknown as { current: readonly INormalizedRelation[]; historical: readonly IRetrievedRelation[]; evidence?: readonly string[] };
    assert.equal(input.current[0]?.predicate, "PREFERS", "normalized current relation");
    assert.equal(input.historical[0]?.predicate, "DISLIKES", "historical relations");
    assert.ok((input.evidence ?? []).some(e => e.includes("tea")), "evidence derived from facts");

    // 4F.10: conflict detected, FeedbackEngine invoked.
    assert.equal(result.conflicts, 1, "PREFERS vs DISLIKES → existing-rule conflict");
    assert.equal(pipeline.getLatestFeedback().length, 1);
    assert.equal(pipeline.getLatestFeedback()[0]?.action, "SUPERSEDED");

    // 4F.6 ordering: conflict → feedback → store (NEVER store first).
    assert.deepEqual(order, ["detect", "feedback"], "conflict + feedback run before persistence");
    assert.equal(store.calls.length, 1, "accepted fact reached the store");
    assert.equal(result.persisted, 1);
    assert.equal(result.received, 1);
    assert.equal(result.normalized, 1);
    ok("delegation: normalize → ConflictDetector → FeedbackEngine → store, in order (4F.4/4F.5/4F.6)");
}


// ---------------------------------------------------------------------------
// 5. 4F.8 provenance: execution facts stay distinguishable end-to-end
// ---------------------------------------------------------------------------
{
    const store = recordingStore();
    const pipeline = createMemoryPipeline({ store });

    await pipeline.process([
        executionFact({
            subject: "user", predicate: "HAS_EVENT", object: "Team standup",
            planId: "plan-123", stepId: "calendar", kind: "tool", tool: "calendar.list_events",
        }),
        executionFact({
            subject: "ravi", predicate: "PREFERS", object: "tea",
            planId: "plan-123", stepId: "record-pref", kind: "action", action: "preference.record",
        }),
    ]);

    const relations = pipeline.getLatestRelations();
    const toolRelation = relations.find(r => r.tool === "calendar.list_events");
    const actionRelation = relations.find(r => r.action === "preference.record");
    assert.ok(toolRelation, "tool fact normalized");
    assert.ok(actionRelation, "action fact normalized");

    // 4F.8: source / kind / tool / action all survive.
    assert.equal(toolRelation.source, "execution");
    assert.equal(toolRelation.kind, "tool");
    assert.equal(toolRelation.planId, "plan-123");
    assert.equal(toolRelation.stepId, "calendar");
    assert.equal(actionRelation.kind, "action");
    assert.equal(actionRelation.action, "preference.record");
    assert.equal(actionRelation.tool, undefined);
    assert.equal(toolRelation.action, undefined);

    // Persisted too (additive Phase 3 fields, no Cypher change).
    const saved = store.calls[0]!.relations;
    assert.ok(saved.some(r => r.tool === "calendar.list_events"));
    assert.ok(saved.some(r => r.action === "preference.record"));
    ok("provenance (4F.8): source/planId/stepId/kind/tool/action preserved → store");

    // Distinguishable from the conversation path: legacy relations carry none.
    const legacy = normalizeRelation({ subject: "Ravi", predicate: "likes", object: "Coffee" });
    assert.ok(legacy);
    assert.equal(legacy.source, undefined, "conversation path unchanged — no provenance invented");
    assert.equal(legacy.kind, undefined);
    ok("conversation pipeline unaffected: legacy normalization output identical");
}

// ---------------------------------------------------------------------------
// 6. 4F.10: multiple facts + rejected facts follow existing rules
// ---------------------------------------------------------------------------
{
    const store = recordingStore();
    const pipeline = createMemoryPipeline({ store });

    const result = await pipeline.process([
        executionFact({ subject: "Ravi", predicate: "LIKES", object: "Coffee" }),
        executionFact({ subject: "Ravi", predicate: "LIVES_IN", object: "Pune" }),
        executionFact({ subject: "", predicate: "IS", object: "broken" }), // rejected
        executionFact({ subject: "ravi", predicate: "LIKES", object: "Coffee" }), // duplicate
    ]);

    assert.equal(result.received, 4);
    assert.equal(result.normalized, 3, "three usable relations");
    assert.equal(result.rejected, 1, "unusable fact rejected at normalization");
    assert.equal(result.persisted, 2, "exact duplicate collapsed before write");
    assert.equal(store.calls.length, 1, "single atomic write");
    assert.equal(store.calls[0]!.relations.length, 2, "exact-duplicate collapsed");
    ok("multiple facts: batch processed, rejected counted, deduplicated before store");

    // A conflicting fact still follows EXISTING rules (Phase 3 saves, then
    // self-corrects) — conflict does not silently drop it here.
    const store2 = recordingStore();
    const conflictPipeline = createMemoryPipeline({
        store: store2,
        detect: input => ({
            conflict: true,
            findings: input.current.map(current => ({
                subject: current.subject,
                object: current.object,
                current,
                historical: [{ subject: current.subject, predicate: "DISLIKES", object: current.object, confidence: null }],
                explicitEvidence: false,
            })),
        }),
    });
    const conflicting = await conflictPipeline.process([
        executionFact({ subject: "ravi", predicate: "LIKES", object: "Coffee" }),
    ]);
    assert.equal(conflicting.conflicts, 1);
    assert.equal(conflicting.persisted, 1, "existing rule: save, feedback/decision downstream");
    assert.equal(conflictPipeline.getLatestFeedback()[0]?.action, "CONFLICTING", "no explicit evidence → keep both");
    ok("conflicting fact follows existing rules: persisted + CONFLICTING feedback");
}


// ---------------------------------------------------------------------------
// 7. Full chain 4D → 4E → 4F: extraction is never bypassed (4F.10)
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    tools.register({
        name: "calendar.list_events",
        description: "list events",
        requiredArgs: ["date"],
        async executor() { return [{ title: "Team standup", time: "09:00" }]; },
    });
    tools.register({
        name: "web.search",
        description: "search",
        requiredArgs: ["query"],
        async executor(args) { return { query: args["query"], results: ["a"] }; },
    });
    const executor = new PlanExecutor(tools, { actions: createDefaultActionRegistry() });

    // Real execution WITH tool args (date=tomorrow) — they must never surface.
    const result = await executor.execute(createPlanShell("4f chain", [
        step("get-events", "Retrieve tomorrow's calendar events", {
            kind: "tool", tool: "calendar.list_events", args: { date: "tomorrow" },
        }),
        step("pick", "Pick a highlight", {
            kind: "action", action: "list.pick",
            args: { items: ["BuildForms", "KnowStack"], count: 1 },
            dependsOn: ["get-events"],
        }),
    ]));

    // 4D
    const candidates = createExecutionResultProcessor().process(result);
    assert.deepEqual(candidates.map(c => c.stepId).sort(), ["get-events", "pick"]);
    assert.ok(candidates.every(c => !("args" in c)), "candidates carry no args");

    // 4E
    const extractor = createDeterministicMemoryExtractor();
    const facts = (await Promise.all(candidates.map(c => extractor.extract(c)))).flatMap(e => e.facts);
    // calendar facts extracted; list.pick deliberately yields none.
    assert.equal(facts.length, 2, "HAS_EVENT + OCCURS_AT only — pick produced no facts");
    assert.ok(facts.every(f => f.source === "execution"));

    // 4F
    const store = recordingStore();
    const pipeline = createMemoryPipeline({ store });
    const pipelineResult = await pipeline.process(facts);

    assert.equal(pipelineResult.received, 2);
    assert.equal(pipelineResult.normalized, 2);
    assert.equal(pipelineResult.persisted, 2);
    assert.equal(store.calls.length, 1);

    // Tool args never reach the fact/persistence layer.
    const serialized = JSON.stringify(store.calls[0]!.relations);
    assert.ok(!serialized.includes("tomorrow"), "args (date=tomorrow) never persisted");
    assert.ok(serialized.includes("team standup"), "MCP-style output reached the store via facts");
    // Provenance intact across the whole chain. (Non-canonical predicates are
    // lowercased by Phase 3 normalization — match case-insensitively.)
    const savedEvent = store.calls[0]!.relations.find(r => r.predicate.toUpperCase() === "HAS_EVENT");
    assert.equal(savedEvent?.tool, "calendar.list_events");
    assert.equal(savedEvent?.kind, "tool");
    assert.equal(savedEvent?.planId, result.planId);
    assert.equal(savedEvent?.stepId, "get-events");
    ok("chain: execution → candidates → facts → store; args never leak, provenance intact");

    // A non-semantic candidate (list.pick) cannot bypass extraction into 4F.
    const store2 = recordingStore();
    const pickOnly = createExecutionResultProcessor().process({
        planId: "p", goal: "g", status: "completed",
        startedAt: "2026-09-30T10:00:00.000Z", finishedAt: "2026-09-30T10:00:01.000Z",
        steps: [{ stepId: "pick", goal: "Pick", kind: "action", action: "list.pick", status: "completed", output: { picked: ["KnowStack"] } }],
    });
    const pickFacts = (await Promise.all(pickOnly.map(c => extractor.extract(c)))).flatMap(e => e.facts);
    assert.deepEqual(pickFacts, [], "list.pick → no facts");
    const pickPipeline = await createMemoryPipeline({ store: store2 }).process(pickFacts);
    assert.equal(pickPipeline.received, 0);
    assert.equal(store2.calls.length, 0, "candidate with no facts → NO persistence (never bypasses 4E)");
    ok("extraction gate: non-semantic candidates produce no facts → nothing reaches Neo4j");

    // Decision facts remain distinguishable from tool/action facts (4F.10).
    const decisionPipeline = createMemoryPipeline({ store: recordingStore() });
    await decisionPipeline.process([
        executionFact({ subject: "ravi", predicate: "IS", object: "BuildForms user", kind: "decision" }),
    ]);
    assert.equal(decisionPipeline.getLatestRelations()[0]?.kind, "decision", "decision provenance preserved");
    ok("decision fact processed and remains distinguishable (kind=decision)");
}

// 4F adapter sanity: fact → Phase 3 relation shape (4F.3)
{
    const relation = factToRelation(executionFact({ subject: "Ravi", predicate: "PREFERS", object: "Tea", tool: "memory.note" }));
    assert.deepEqual(
        { subject: relation.subject, predicate: relation.predicate, object: relation.object, confidence: relation.confidence },
        { subject: "Ravi", predicate: "PREFERS", object: "Tea", confidence: 0.7 },
    );
    assert.equal(relation.source, "execution");
    assert.equal(relation.tool, "memory.note");
    const normalized = normalizeRelations([relation]);
    assert.equal(normalized[0]?.predicate, "PREFERS");
    ok("adapter: IMemoryFact → IExtractedRelation → Phase 3 normalization reused");
}

// ---------------------------------------------------------------------------
// 8. 4G — self-correction: opt-in boundary + rules DELEGATED to the EXISTING
//    engine (mocked runner — no Neo4j, no second correction engine)
// ---------------------------------------------------------------------------
{
    // (a) 4G.2 opt-in: conflict detected, but no port → corrected stays 0,
    //     i.e. Phase 4F behavior is untouched by default.
    const noPort = createMemoryPipeline({
        store: recordingStore(),
        historical: async () => [{ subject: "ravi", predicate: "DISLIKES", object: "coffee", confidence: 0.9 }],
    });
    const optIn = await noPort.process([
        executionFact({ subject: "Ravi", predicate: "PREFERS", object: "coffee" }),
    ]);
    assert.equal(optIn.conflicts, 1, "conflict detected");
    assert.equal(optIn.corrected, 0, "no port injected → no mutations (4F default intact)");
    ok("4G opt-in boundary: conflicts counted; corrections only when the port is injected");

    // (b) SUPERSEDED → the existing engine's RULE_SUPERSEDE runs a parameterized
    //     DELETE through the mocked runner (values never inlined — 4G.4).
    const queries: { cypher: string; params: Record<string, unknown> | undefined }[] = [];
    const engine = createSelfCorrectionEngine({
        runQuery: async (cypher, params) => {
            queries.push({ cypher, params });
            return { records: [] } as unknown as IGraphQueryResult;
        },
    });
    const correcting = createMemoryPipeline({
        store: recordingStore(),
        historical: async () => [{ subject: "ravi", predicate: "DISLIKES", object: "coffee", confidence: 0.9 }],
        selfCorrection: engine,
    });
    const superseded = await correcting.process([
        executionFact({ subject: "Ravi", predicate: "PREFERS", object: "coffee" }),
    ]);
    assert.equal(superseded.conflicts, 1, "detected");
    assert.equal(superseded.corrected, 1, "approved SUPERSEDED correction executed");
    const report = correcting.getLatestCorrection();
    assert.ok(report, "correction report exposed");
    assert.equal(report.mutationsApplied, 1, "mutationsApplied = approved + executed");
    assert.equal(report.corrections[0]?.rule, SELF_CORRECTION_RULES.Supersede);
    assert.equal(queries.length, 1, "exactly one graph mutation ran");
    assert.match(queries[0]!.cypher, /DELETE r/, "reuses the existing delete operation");
    assert.ok(!queries[0]!.cypher.includes("coffee"), "values stay parameterized, never inlined");
    assert.deepEqual(queries[0]!.params, { subject: "ravi", predicate: "DISLIKES", object: "coffee" });
    ok("4G.3/4G.4 SUPERSEDED: detected → approved → parameterized mutation executed");

    // (c) CONFLICTING (no explicit evidence) → the engine AUTHORIZES keep-both:
    //     detected but NOT corrected; no Cypher runs, existing relation preserved.
    const keptQueries: unknown[] = [];
    const keepEngine = createSelfCorrectionEngine({
        runQuery: async cypher => {
            keptQueries.push(cypher);
            return { records: [] } as unknown as IGraphQueryResult;
        },
    });
    const keeping = createMemoryPipeline({
        store: recordingStore(),
        historical: async () => [{ subject: "ravi", predicate: "DISLIKES", object: "coffee", confidence: null }],
        detect: input => ({
            conflict: true,
            findings: input.current.map(current => ({
                subject: current.subject,
                object: current.object,
                current,
                historical: [{ subject: "ravi", predicate: "DISLIKES", object: "coffee", confidence: null }],
                explicitEvidence: false,
            })),
        }),
        selfCorrection: keepEngine,
    });
    const kept = await keeping.process([
        executionFact({ subject: "ravi", predicate: "LIKES", object: "coffee" }),
    ]);
    assert.equal(kept.conflicts, 1, "conflict detected");
    assert.equal(kept.corrected, 0, "engine did NOT authorize a mutation");
    assert.equal(keptQueries.length, 0, "no graph mutation for keep-both");
    assert.equal(keeping.getLatestCorrection()?.corrections[0]?.rule, SELF_CORRECTION_RULES.KeepConflict);
    ok("4G.3 rules: detected ≠ approved — CONFLICTING keeps both edges untouched");

    // (d) No conflict → the engine is never invoked.
    let invocations = 0;
    const spy = {
        async applyCorrections(findings: readonly IConflictFinding[]) {
            invocations++;
            assert.ok(findings.length > 0, "engine only called with findings");
            return { corrections: [], mutationsApplied: 0, text: "" };
        },
    };
    const quiet = createMemoryPipeline({ store: recordingStore(), selfCorrection: spy });
    await quiet.process([executionFact({ subject: "Ravi", predicate: "LIKES", object: "Coffee" })]);
    assert.equal(invocations, 0, "no findings → engine skipped");
    ok("4G: engine invoked only when a conflict was actually detected");

    // (e) 4G.4 — a failed mutation must surface, never report success.
    const failing = createMemoryPipeline({
        store: recordingStore(),
        historical: async () => [{ subject: "ravi", predicate: "DISLIKES", object: "coffee", confidence: null }],
        selfCorrection: {
            async applyCorrections() { throw new Error("mutation failed"); },
        },
    });
    await assert.rejects(
        failing.process([executionFact({ subject: "Ravi", predicate: "PREFERS", object: "coffee" })]),
        /mutation failed/,
        "correction failure propagates to the caller",
    );
    ok("4G.4 failure path: a rejected correction propagates — never silently 'corrected'");
}

// ---------------------------------------------------------------------------
// 9. CRITICAL E2E (4F.9) — first complete execution-memory path via REAL Neo4j
// ---------------------------------------------------------------------------
{
    const env = process.env;
    if (!env.NEO4J_URI || !env.NEO4J_USER || !env.NEO4J_PASSWORD) {
        throw new Error(
            "4F E2E requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD — run via `npm run test:memory-pipeline`",
        );
    }
    const { Neo4jMemoryStore } = await import("../app/graphStore.js");
    const store = new Neo4jMemoryStore({
        uri: env.NEO4J_URI,
        user: env.NEO4J_USER,
        password: env.NEO4J_PASSWORD,
        database: env.NEO4J_DATABASE || "neo4j",
    });
    await store.initialize();

    const EVENT = "4f e2e dentist";
    const DRINK = "4f e2e beverage";
    const cleanup = async () => {
        await store.runQuery(
            "MATCH (b:Entity) WHERE b.name IN $names DETACH DELETE b",
            { names: [EVENT, DRINK, `${EVENT} 10:30`] },
        );
    };
    // History port now backed by the REAL graph (4F.4 delegation).
    const loadHistory = async (subjects: readonly string[]): Promise<IRetrievedRelation[]> => {
        const out = await store.runQuery(
            "MATCH (a)-[r:RELATES_TO]->(b) WHERE a.name IN $subjects " +
            "RETURN a.name AS subject, r.predicate AS predicate, b.name AS object, r.confidence AS confidence",
            { subjects: [...subjects] },
        );
        return out.records
            .map(r => ({
                subject: r.get("subject"),
                predicate: r.get("predicate"),
                object: r.get("object"),
                confidence: r.get("confidence"),
            }))
            .filter(r =>
                typeof r.subject === "string"
                && typeof r.predicate === "string"
                && typeof r.object === "string")
            .map(r => ({
                subject: r.subject as string,
                predicate: r.predicate as string,
                object: r.object as string,
                confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
            }));
    };

    try {
        await cleanup();
        // Part A: full 4D → 4E → 4F chain writes to the real graph.
        const tools = new ToolRegistry();
        tools.register({
            name: "calendar.list_events",
            description: "list events",
            requiredArgs: ["date"],
            async executor() { return [{ title: EVENT, time: "10:30" }]; },
        });
        const execution = await new PlanExecutor(tools, { actions: createDefaultActionRegistry() })
            .execute(createPlanShell("4f e2e", [
                step("get-events", "Retrieve calendar events", {
                    kind: "tool", tool: "calendar.list_events", args: { date: "tomorrow" },
                }),
            ]));

        const candidates = createExecutionResultProcessor().process(execution);
        const extractor = createDeterministicMemoryExtractor();
        const facts = (await Promise.all(candidates.map(c => extractor.extract(c)))).flatMap(e => e.facts);
        assert.equal(facts.length, 2, "HAS_EVENT + OCCURS_AT extracted");

        const pipeline = createMemoryPipeline({ store, historical: loadHistory });
        const first = await pipeline.process(facts);
        assert.equal(first.normalized, 2);
        assert.equal(first.persisted, 2, "facts persisted to Neo4j");
        assert.equal(first.conflicts, 0, "fresh entities → no conflict");

        const edge = await store.runQuery(
            "MATCH (a)-[r:RELATES_TO]->(b) WHERE toLower(r.predicate) = toLower($p) AND b.name = $o " +
            "RETURN a.name AS s, r.confidence AS c",
            { p: "HAS_EVENT", o: EVENT },
        );
        assert.equal(edge.records.length, 1, "HAS_EVENT edge exists in Neo4j");
        assert.equal(edge.records[0]?.get("s"), "user");
        assert.equal(Number(edge.records[0]?.get("c")), 0.7, "confidence persisted");
        const at = await store.runQuery(
            "MATCH (a)-[r:RELATES_TO]->(b) WHERE toLower(r.predicate) = toLower($p) AND a.name = $o RETURN b.name AS t",
            { p: "OCCURS_AT", o: EVENT },
        );
        assert.equal(at.records.length, 1, "OCCURS_AT edge exists in Neo4j");
        assert.equal(at.records[0]?.get("t"), "10:30");
        ok("E2E: execution → candidates → facts → Neo4j (graph verified)");



        // Part B: conflict against REAL graph history, then feedback.
        const seed = await pipeline.process([
            executionFact({ subject: "Ravi", predicate: "DISLIKES", object: DRINK, tool: "memory.note" }),
        ]);
        assert.equal(seed.persisted, 1);

        const conflicted = await pipeline.process([
            executionFact({ subject: "Ravi", predicate: "PREFERS", object: DRINK, tool: "memory.note", stepId: "step-2" }),
        ]);
        assert.equal(conflicted.conflicts, 1, "PREFERS vs DISLIKES conflict detected against real history");
        assert.equal(pipeline.getLatestFeedback().length, 1);
        assert.ok(["SUPERSEDED", "CONFLICTING"].includes(pipeline.getLatestFeedback()[0]!.action));
        assert.equal(conflicted.persisted, 1, "existing rule: save; self-correction is a later phase");
        // Provenance survived the REAL conflict path (4F.8).
        assert.equal(pipeline.getLatestFindings()[0]?.current.source, "execution");
        assert.equal(pipeline.getLatestFindings()[0]?.current.tool, "memory.note");

        const both = await store.runQuery(
            "MATCH (a)-[r:RELATES_TO]->(b) WHERE a.name = $s AND b.name = $o RETURN r.predicate AS p",
            { s: "ravi", o: DRINK },
        );
        assert.equal(both.records.length, 2, "both predicates retained pending self-correction");
        ok("E2E: conflict vs real history → feedback → persisted (existing rules honoured)");

        // Part C: 4G — self-correction against the REAL graph.
        //   Historical: ravi -DISLIKES-> DRINK  (written by Part B)
        //   New fact:   ravi -PREFERS->  DRINK
        //   → conflict → feedback (SUPERSEDED: evidence mentions DRINK) →
        //   engine DELETES the superseded edge → GRAPH VERIFIED (not just Cypher).
        const correcting = createMemoryPipeline({
            store,
            historical: loadHistory,
            selfCorrection: createSelfCorrectionEngine(store),
        });
        const correctedRun = await correcting.process([
            executionFact({ subject: "Ravi", predicate: "PREFERS", object: DRINK, tool: "memory.note", stepId: "step-3" }),
        ]);
        assert.equal(correctedRun.conflicts, 1, "4G E2E: conflict detected against real history");
        assert.equal(correcting.getLatestFeedback().length, 1, "4G E2E: feedback decided");
        assert.ok(
            ["SUPERSEDED", "CONFLICTING"].includes(correcting.getLatestFeedback()[0]!.action),
            "4G E2E: feedback action recorded",
        );
        const report4g = correcting.getLatestCorrection();
        assert.ok(report4g, "4G E2E: correction report produced");
        assert.equal(correctedRun.corrected, report4g.mutationsApplied, "mutationsApplied is authoritative");
        assert.equal(correctedRun.corrected, 1, "SUPERSEDED: exactly one superseded edge removed");
        assert.equal(report4g.corrections[0]?.rule, SELF_CORRECTION_RULES.Supersede);
        // Verify the resulting GRAPH STATE — not merely the proposed Cypher (4G.4).
        const after = await store.runQuery(
            "MATCH (a)-[r:RELATES_TO]->(b) WHERE a.name = $s AND b.name = $o RETURN r.predicate AS p",
            { s: "ravi", o: DRINK },
        );
        assert.deepEqual(
            after.records.map(r => r.get("p")),
            ["PREFERS"],
            "graph verified: DISLIKES removed, PREFERS is current knowledge",
        );
        ok("4G E2E: conflict → feedback → self-correction → graph state verified");
    } finally {
        await cleanup().catch(() => undefined);
        await store.close().catch(() => undefined);
    }
}

console.log(`\n✅ Memory Pipeline (4F + 4G): ${pass} checks passed.`);

