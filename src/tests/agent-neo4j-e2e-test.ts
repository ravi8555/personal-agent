// Phase 4J — Full Agent ↔ Neo4j end-to-end verification.
//
// Connects the 4H/4I Agent-loop proofs with REAL persistence. Everything is
// real — Agent, Neo4jMemoryStore, GraphKnowledgeRetriever, the deterministic
// 4D→4E chain, the 4F/4G pipeline and the existing SelfCorrectionEngine —
// except ONE seam: withResponder() replaces only the final LLM call. It never
// replaces graph retrieval or the execution-memory pipeline. (The deterministic
// planner is injected the same way every other suite does so plan content is
// fixed; the graph path itself is untouched.)
//
// The critical proof is three-way agreement, not a pipeline tally:
//   actual Neo4j graph == refreshed running context == LLM system prompt
// and the outcome distinction:
//   detected conflict (conflicts) ≠ corrected (mutationsApplied) ≠
//   APPLIED graph mutation — the last one is verified BY QUERYING THE GRAPH.
//
// The retriever's pre-existing double initial call is OUT OF SCOPE here:
// assertions only look at first/last retrieval snapshots.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "dotenv/config";

import { Agent } from "../app/agent.js";
import type { AgentResponder } from "../app/agent.js";
import { Planner } from "../app/planner.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import { Neo4jMemoryStore } from "../app/graphStore.js";
import { createMemoryPipeline } from "../app/memoryPipeline/memoryPipeline.js";
import { createSelfCorrectionEngine } from "../app/selfCorrection.js";
import { createGraphKnowledgeRetriever } from "../app/graphRetrieval.js";
import type { IRelevantKnowledge, IRetrievedRelation } from "../app/graphRetrieval.js";
import type { KnowledgeRetriever } from "../app/contextWatcher.js";

console.log(`
=================================================
AGENT <-> NEO4J E2E TEST (Phase 4J)
real Agent + real store + real retriever + real
pipeline + real SelfCorrectionEngine
ONE seam: withResponder() = final LLM call only.
Proof: graph == refreshed context == LLM prompt.
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log("  PASS " + label); pass++; };

const env = process.env;
if (!env.NEO4J_URI || !env.NEO4J_USER || !env.NEO4J_PASSWORD) {
    throw new Error("4J E2E requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD — run via `npm run test:agent-neo4j-e2e`");
}

// Isolated fixtures: the fixture OBJECTS get unique per-run names; the subject
// is the shared "ravi" entity and is NEVER deleted. The topic analyzer SKIPS
// tokens containing digits, so the run suffix is letters-only:
// 16 random bytes mapped to letters only (~75 bits — safe for concurrent or
// repeated runs).
const RUN = Array.from(
    randomBytes(16),
    (byte) => String.fromCharCode(97 + (byte % 26)),
).join("");

const FIXTURE = `beveragequark${RUN}`;
const PARTIAL = `glacierquark${RUN}`;
const SUBJECT = "ravi"; // Shared entity: never delete it in test cleanup.

const store = new Neo4jMemoryStore({
    uri: env.NEO4J_URI,
    user: env.NEO4J_USER,
    password: env.NEO4J_PASSWORD,
    database: env.NEO4J_DATABASE || "neo4j",
});
await store.initialize();

const cleanup = async () => {
    await store.runQuery(
        "MATCH (b:Entity) WHERE b.name IN $names DETACH DELETE b",
        { names: [FIXTURE, PARTIAL] },
    );
};


/** REAL historical loader over the graph (same pattern as the 4F E2E). */
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
        .filter(r => typeof r.subject === "string" && typeof r.predicate === "string" && typeof r.object === "string")
        .map(r => ({
            subject: r.subject as string,
            predicate: r.predicate as string,
            object: r.object as string,
            confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
        }));
};

/** Fixture: seed the STALE graph state — (ravi)-[DISLIKES @0.9]->(object). */
const seedDislikes = async (object: string) => {
    await store.runQuery(
        `MERGE (a:Entity {name: $s})
         MERGE (b:Entity {name: $o})
         MERGE (a)-[:RELATES_TO {predicate: 'DISLIKES', confidence: 0.9, extractedAt: $now, extractionId: '4j-seed'}]->(b)`,
        { s: SUBJECT, o: object, now: new Date().toISOString() },
    );
};

/** Deterministic planner over the real ToolRegistry (plan seam like all suites). */
function preferencePlanner(steps: ReadonlyArray<Record<string, unknown>>): Planner {
    return new Planner({
        knownTools: () => ["preference.record"],
        requiredArgs: () => ({ "preference.record": ["fact"] }),
        generatePlan: async () => JSON.stringify({ goal: "4j task", steps }),
    });
}

try {
    await cleanup();
    await seedDislikes(FIXTURE);

    // -------------------------------------------------------------------------
    // Scenario A — supersede: conflict DETECTED, correction REQUESTED, mutation
    // APPLIED. The graph is authoritative; then graph == refreshed context ==
    // LLM prompt.
    // -------------------------------------------------------------------------
    const tools = new ToolRegistry();
    tools.register({
        name: "preference.record",
        description: "record a preference fact",
        requiredArgs: ["fact"],
        // Real tool whose STRUCTURED output already is a fact — the real 4E
        // `structural.explicit-triple` rule turns it into a LIKES memory.
        async executor() { return { subject: SUBJECT, predicate: "LIKES", object: FIXTURE }; },
    });

    const prompts: string[] = [];
    const responder: AgentResponder = async messages => {
        const system = messages.find(m => m.role === "system");
        if (system) prompts.push(system.content);
        return JSON.stringify({ step: "output", content: "Noted — your preference has been recorded." });
    };

    // Real retrieval, merely OBSERVED (not replaced): wraps the real
    // GraphKnowledgeRetriever exactly like withMemoryStore() would wire it.
    const realRetriever = createGraphKnowledgeRetriever(store);
    const snapshots: IRelevantKnowledge[] = [];
    const observedRetriever: KnowledgeRetriever = async (topic, processor) => {
        const knowledge = (await realRetriever(topic, processor)) as IRelevantKnowledge | null;
        if (knowledge) snapshots.push(knowledge);
        return knowledge;
    };

    const agent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withMemoryStore(store)
        .withKnowledgeRetriever(observedRetriever)   // real retriever, observed
        .withResponder(responder)                    // the ONLY behavioral seam
        .withToolRegistry(tools)
        .withPlanner(preferencePlanner([
            { id: "record", goal: "Record the preference", tool: "preference.record", args: { fact: FIXTURE } },
        ]))
        .withExecutionMemoryPipeline(createMemoryPipeline({
            store,                                     // REAL Neo4j
            historical: loadHistory,                   // REAL graph history
            selfCorrection: createSelfCorrectionEngine(store), // REAL engine
        }))
        .build();

    const messages = await agent.run(`Schedule a follow-up item for ${SUBJECT} about ${FIXTURE}`);
    assert.equal(agent.getLastIntent()?.type, "task", "task intent drives the planning path");
    assert.ok(messages && messages.length > 0, "user received a response");

    // (1) The tally reports detected ≠ corrected — but proves nothing about
    //     the graph on its own.
    const tally = agent.getLastExecutionMemory();
    assert.ok(tally, "pipeline tally exposed");
    assert.equal(tally.conflicts, 1, "conflict DETECTED (ravi DISLIKES → LIKES)");
    assert.equal(tally.persisted, 1, "new relation persisted");
    assert.equal(tally.corrected, 1, "correction REQUESTED + applied (mutationsApplied)");
    assert.equal(agent.getLastExecutionMemoryState(), "changed");

    // (2) The GRAPH is authoritative: the superseded edge is ACTUALLY gone and
    //     the new edge carries execution provenance (4I).
    const edges = await store.runQuery(
        `MATCH (a)-[r:RELATES_TO]->(b) WHERE a.name = $s AND b.name = $o
         RETURN r.predicate AS p, r.source AS source, r.planId AS planId, r.kind AS kind, r.tool AS tool`,
        { s: SUBJECT, o: FIXTURE },
    );
    assert.deepEqual(edges.records.map(r => r.get("p")), ["LIKES"], "APPLIED: DISLIKES deleted, LIKES is current");
    const edge = edges.records[0]!;
    assert.equal(edge.get("source"), "execution");
    assert.equal(edge.get("tool"), "preference.record");
    assert.equal(edge.get("kind"), "tool");
    assert.equal(edge.get("planId"), agent.getLastPlan()?.id, "provenance planId matches the executed plan");
    ok("A: conflict detected ≠ correction requested ≠ APPLIED — graph verified, provenance stamped");

    // (3) Retrieval snapshots show stale → fresh across the refresh.
    const fixtureEdges = (k: IRelevantKnowledge) => k.relations.filter(r => r.object === FIXTURE || r.subject === FIXTURE);
    assert.ok(snapshots.length >= 2, "retrieval ran before and after the chain");
    assert.ok(fixtureEdges(snapshots[0]!).some(r => r.predicate === "DISLIKES"), "initial retrieval saw the STALE edge");
    const last = snapshots[snapshots.length - 1]!;
    assert.ok(fixtureEdges(last).some(r => r.predicate === "LIKES"), "refresh retrieved the corrected graph");
    assert.ok(!fixtureEdges(last).some(r => r.predicate === "DISLIKES"), "refresh no longer returns the superseded edge");

    // (4) THREE-WAY AGREEMENT: graph == refreshed context == LLM prompt.
    const refreshed = await agent.buildRunningContext();
    assert.ok(refreshed, "post-run context rebuild succeeds");
    assert.ok(refreshed.text.includes(FIXTURE) && refreshed.text.includes("LIKES"), "refreshed context carries current knowledge");
    assert.ok(!refreshed.text.includes("DISLIKES"), "refreshed context does NOT carry the superseded relation");
    const prompt = prompts[prompts.length - 1]!;
    assert.ok(prompt.includes(FIXTURE) && prompt.includes("LIKES"), "LLM prompt carries current knowledge");
    assert.ok(!prompt.includes("DISLIKES"), "LLM prompt does NOT carry the superseded relation");
    ok("A: graph == refreshed context == LLM prompt (three-way agreement)");

    // -------------------------------------------------------------------------
    // Scenario B — partial write (4I hardening in the REAL Agent): persistence
    // lands, correction fails → "possibly-changed" → refresh attempted, and
    // the user still gets a response.
    // -------------------------------------------------------------------------
    await seedDislikes(PARTIAL);
    const promptsB: string[] = [];
    const responderB: AgentResponder = async messages => {
        const system = messages.find(m => m.role === "system");
        if (system) promptsB.push(system.content);
        return JSON.stringify({ step: "output", content: "I recorded that, though part of the memory update failed." });
    };
    const toolsB = new ToolRegistry();
    toolsB.register({
        name: "preference.record",
        description: "record a preference fact",
        requiredArgs: ["fact"],
        async executor() { return { subject: SUBJECT, predicate: "LIKES", object: PARTIAL }; },
    });
    const partialAgent = Agent.builder()
        .setInstructions("You are a personal assistant.")
        .withMemoryStore(store)
        .withResponder(responderB)
        .withToolRegistry(toolsB)
        .withPlanner(preferencePlanner([
            { id: "record", goal: "Record the preference", tool: "preference.record", args: { fact: PARTIAL } },
        ]))
        .withExecutionMemoryPipeline(createMemoryPipeline({
            store,
            historical: loadHistory,
            selfCorrection: { async applyCorrections() { throw new Error("correction backend down"); } },
        }))
        .build();

    const messagesB = await partialAgent.run(`Schedule a follow-up item for ${SUBJECT} about ${PARTIAL}`);
    assert.ok(messagesB && messagesB.length > 0, "FAILURE SCENARIO: user still receives a response");
    assert.equal(partialAgent.getLastExecutionMemory(), null, "no tally on failure");
    assert.equal(partialAgent.getLastExecutionMemoryState(), "possibly-changed", "4I: typed correction-stage failure");

    // Graph: the partial write LANDED; the delete did not.
    const partialEdges = await store.runQuery(
        "MATCH (a)-[r:RELATES_TO]->(b) WHERE a.name = $s AND b.name = $o RETURN r.predicate AS p ORDER BY p",
        { s: SUBJECT, o: PARTIAL },
    );
    assert.deepEqual(
        partialEdges.records.map(r => r.get("p")),
        ["DISLIKES", "LIKES"],
        "partial state: new fact persisted, superseded edge still present",
    );

    // Refresh attempted → the LLM prompt reflects the TRUE partial graph.
    const promptB = promptsB[promptsB.length - 1]!;
    assert.ok(promptB.includes(PARTIAL) && promptB.includes("LIKES"), "refresh after the failed pipeline surfaced the persisted fact");
    assert.ok(promptB.includes("DISLIKES"), "prompt reflects the true partial state (both edges)");
    ok("B: partial write → possibly-changed → refresh attempted → response delivered");

    await cleanup();
} finally {
    await cleanup().catch(() => undefined);
    await store.close().catch(() => undefined);
}

console.log(`\n✅ Agent ↔ Neo4j E2E (4J): ${pass} checks passed.`);
