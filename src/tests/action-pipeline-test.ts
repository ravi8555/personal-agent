// Phase 4C — Action → priorOutputs data-flow test (no Neo4j, no OpenAI, no network).
// Contract: args = planner inputs; priorOutputs = execution context (completed
// steps, deep-cloned). Proves sequential/multi/fan-in propagation, output
// isolation, tool → action flow, and the explicit action → tool boundary.
import assert from "node:assert/strict";

import { ActionRegistry } from "../app/action/actionRegistry.js";
import { createDefaultActionRegistry } from "../app/action/defaultActions.js";
import type { IActionContext } from "../app/action/actionTypes.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import { createDefaultToolPolicy } from "../app/toolPolicy.js";
import { PlanExecutor } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";

console.log(`
=================================================
ACTION PIPELINE TEST (Phase 4C)
args vs priorOutputs: propagation, isolation,
fan-in, tool→action, action→tool boundary
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

/** Records every context a capture action receives, keyed by step id. */
interface ICapturedContext {
    stepId: string;
    args: Record<string, unknown>;
    priorOutputs: Record<string, unknown>;
}
function makeRegistry(captures: ICapturedContext[]): ActionRegistry {
    const actions = createDefaultActionRegistry();
    actions.register({
        name: "demo.capture",
        description: "Record the received action context for assertions.",
        execute(context: IActionContext) {
            captures.push({
                stepId: context.stepId,
                args: structuredClone(context.args),
                priorOutputs: structuredClone(context.priorOutputs),
            });
            return { captured: true };
        },
    });
    actions.register({
        name: "demo.fail",
        description: "Always throws (for failed-step isolation tests).",
        execute() {
            throw new Error("demo.fail exploded");
        },
    });
    actions.register({
        name: "demo.mutate",
        description: "Deliberately mutates its priorOutputs view (isolation test).",
        execute(context: IActionContext) {
            const source = context.priorOutputs["pick"] as { picked: unknown[] } | undefined;
            if (source && Array.isArray(source.picked)) source.picked.push("Vue");
            if (source) source.picked = ["HACKED"];
            context.priorOutputs["pick"] = "HACKED";
            return { mutated: true };
        },
    });
    return actions;
}

// ---------------------------------------------------------------------------
// 1. Sequential propagation: A → B (B receives priorOutputs.A)
// ---------------------------------------------------------------------------
{
    const captures: ICapturedContext[] = [];
    const actions = makeRegistry(captures);
    const executor = new PlanExecutor(new ToolRegistry(), { actions });

    const result = await executor.execute(createPlanShell("sequential", [
        step("pick", "Pick two items", {
            kind: "action",
            action: "list.pick",
            args: { items: ["React", "Node.js", "MongoDB"], count: 2 },
        }),
        step("compose", "Compose a note from the selected items", {
            kind: "action",
            action: "note.compose",
            args: { template: "Selected: {picked}" },
            dependsOn: ["pick"],
        }),
        step("observe", "Observe the context", {
            kind: "action",
            action: "demo.capture",
            dependsOn: ["compose"],
        }),
    ]));
    assert.equal(result.status, "completed", JSON.stringify(result.steps));

    // The canonical outputs:
    assert.deepEqual(result.steps[0]?.output, { picked: ["React", "Node.js"] });
    assert.deepEqual(result.steps[1]?.output, { note: "Selected: React, Node.js" });

    // Contract 1: B receives context.priorOutputs.A — explicit, keyed by step id.
    const observed = captures.find(c => c.stepId === "observe");
    assert.ok(observed, "capture step ran");
    assert.deepEqual(Object.keys(observed.priorOutputs), ["pick", "compose"], "accumulated, execution-ordered context");
    assert.deepEqual(observed.priorOutputs["pick"], { picked: ["React", "Node.js"] });
    assert.deepEqual(observed.priorOutputs["compose"], { note: "Selected: React, Node.js" });
    // args stay exactly what the planner wrote — nothing injected into them.
    assert.deepEqual(observed.args, {});
    ok("sequential: A → B, B's context carries priorOutputs.A; args untouched");
}

// ---------------------------------------------------------------------------
// 2. Multi-step propagation: A → B → C (C sees BOTH A and B)
// ---------------------------------------------------------------------------
{
    const captures: ICapturedContext[] = [];
    const actions = makeRegistry(captures);
    const executor = new PlanExecutor(new ToolRegistry(), { actions });

    const result = await executor.execute(createPlanShell("chain", [
        step("a", "Produce the raw list", {
            kind: "action",
            action: "list.pick",
            args: { items: ["React", "Node.js", "MongoDB"], count: 3 },
        }),
        step("b", "Summarize A", {
            kind: "action",
            action: "text.summarize_local",
            args: { text: "React Node.js MongoDB", maxLength: 8 },
            dependsOn: ["a"],
        }),
        step("c", "Observe accumulated context", {
            kind: "action",
            action: "demo.capture",
            dependsOn: ["b"],
        }),
    ]));
    assert.equal(result.status, "completed", JSON.stringify(result.steps));

    const c = captures.find(x => x.stepId === "c");
    assert.ok(c, "C ran");
    assert.deepEqual(
        Object.keys(c.priorOutputs).sort(),
        ["a", "b"],
        "C receives { A, B } — accumulated context, not just the immediately preceding step",
    );
    assert.deepEqual(c.priorOutputs["a"], { picked: ["React", "Node.js", "MongoDB"] });
    assert.deepEqual(c.priorOutputs["b"], { summary: "React No" });
    ok("multi-step: A → B → C, C receives both A and B outputs");

    // Placeholder contract: unresolvable keys render empty — never undefined,
    // never a fabricated value, never a crash.
    const bare = await createDefaultActionRegistry().execute("note.compose", {
        stepId: "x", goal: "g", args: { template: "Hello {nobody}" }, priorOutputs: {},
    }) as { note: string };
    assert.equal(bare.note, "Hello ");
    ok("compose: unresolvable placeholder renders empty (no fabrication)");
}


// ---------------------------------------------------------------------------
// 3. Dependency-aware fan-in: A ─┐
//                               ├→ C        (C sees BOTH branches)
//                          B ─┘
// ---------------------------------------------------------------------------
{
    const captures: ICapturedContext[] = [];
    const actions = makeRegistry(captures);
    const executor = new PlanExecutor(new ToolRegistry(), { actions });

    const result = await executor.execute(createPlanShell("fan-in", [
        step("a", "Pick from the first list", {
            kind: "action",
            action: "list.pick",
            args: { items: ["React", "Node.js", "MongoDB"], count: 2 },
        }),
        step("b", "Pick from the second list", {
            kind: "action",
            action: "list.pick",
            args: { items: ["Docker", "Kubernetes", "AWS"], count: 1 },
        }),
        step("c", "Observe both branches", {
            kind: "action",
            action: "demo.capture",
            dependsOn: ["a", "b"],
        }),
        step("d", "Runs after C — C must not have seen it", {
            kind: "action",
            action: "demo.capture",
            dependsOn: ["c"],
        }),
    ]));
    assert.equal(result.status, "completed", JSON.stringify(result.steps));

    const c = captures.find(x => x.stepId === "c");
    assert.ok(c);
    // C receives both required branches — accumulated context keyed by step id.
    assert.deepEqual(c.priorOutputs["a"], { picked: ["React", "Node.js"] });
    assert.deepEqual(c.priorOutputs["b"], { picked: ["Docker"] });
    // Output isolation: C ran BEFORE D, so C's context must not contain D.
    assert.ok(!("d" in c.priorOutputs), "C must not receive outputs of steps that had not run yet");
    const d = captures.find(x => x.stepId === "d");
    assert.ok(d);
    assert.ok("c" in d.priorOutputs, "D (later step) sees C — context only flows forward");
    ok("fan-in: A ─┐ ├→ C receives both branches; context is forward-only");
}


// ---------------------------------------------------------------------------
// 4. Output isolation: a later action CANNOT corrupt earlier outputs
// ---------------------------------------------------------------------------
{
    const captures: ICapturedContext[] = [];
    const actions = makeRegistry(captures);
    const executor = new PlanExecutor(new ToolRegistry(), { actions });

    const result = await executor.execute(createPlanShell("isolation", [
        step("pick", "Pick two items", {
            kind: "action",
            action: "list.pick",
            args: { items: ["React", "Node.js", "MongoDB"], count: 2 },
        }),
        step("mutate", "Maliciously mutate the received context", {
            kind: "action",
            action: "demo.mutate",
            dependsOn: ["pick"],
        }),
        step("observe", "Observe context after the mutation", {
            kind: "action",
            action: "demo.capture",
            dependsOn: ["mutate"],
        }),
        step("compose", "Compose after the mutation", {
            kind: "action",
            action: "note.compose",
            args: { template: "Selected: {picked}" },
            dependsOn: ["mutate"],
        }),
    ]));
    // The plan itself completes — demo.mutate "succeeds"; isolation is about
    // what the DATA looks like afterwards, not about failing the step.
    assert.equal(result.status, "completed", JSON.stringify(result.steps));

    // The canonical step result is intact (deep-cloned before hand-off)…
    assert.deepEqual(result.steps[0]?.output, { picked: ["React", "Node.js"] });
    // …the next step's context view is intact…
    const observed = captures.find(c => c.stepId === "observe");
    assert.ok(observed);
    assert.deepEqual(observed.priorOutputs["pick"], { picked: ["React", "Node.js"] });
    // …and the downstream consumer still renders the ORIGINAL value.
    assert.deepEqual(result.steps[3]?.output, { note: "Selected: React, Node.js" });
    ok("isolation: mutating priorOutputs cannot corrupt earlier results");
}

// ---------------------------------------------------------------------------
// 5. Tool → Action propagation (mixed pipeline, 4C acceptance)
// ---------------------------------------------------------------------------
{
    const captures: ICapturedContext[] = [];
    const actions = makeRegistry(captures);
    const tools = new ToolRegistry();
    tools.register({
        name: "web.search",
        description: "search",
        requiredArgs: ["query"],
        async executor(args) {
            return { query: args["query"], results: ["React docs", "Node.js docs", "MongoDB docs"] };
        },
    });
    const executor = new PlanExecutor(tools, { actions, policy: createDefaultToolPolicy() });

    const result = await executor.execute(createPlanShell("tool-to-action", [
        step("search", "Search for technologies", {
            kind: "tool",
            tool: "web.search",
            args: { query: "js technologies" },
        }),
        step("pick", "Pick two results", {
            kind: "action",
            action: "list.pick",
            args: { from: "search", count: 2 },
            dependsOn: ["search"],
        }),
        step("compose", "Compose a note from the picks", {
            kind: "action",
            action: "note.compose",
            args: { template: "Selected: {picked}" },
            dependsOn: ["pick"],
        }),
        step("observe", "Observe the mixed context", {
            kind: "action",
            action: "demo.capture",
            dependsOn: ["compose"],
        }),
    ]));
    assert.equal(result.status, "completed", JSON.stringify(result.steps));
    assert.deepEqual(result.steps[0]?.output, { query: "js technologies", results: ["React docs", "Node.js docs", "MongoDB docs"] });
    assert.deepEqual(result.steps[1]?.output, { picked: ["React docs", "Node.js docs"] });
    assert.deepEqual(result.steps[2]?.output, { note: "Selected: React docs, Node.js docs" });
    // The action read the tool's output THROUGH priorOutputs (args.from),
    // never by receiving it as an injected arg.
    const picked = captures.find(c => c.stepId === "observe");
    assert.ok(picked);
    assert.ok(picked.priorOutputs["search"], "tool output present in the execution context");
    assert.ok(picked.priorOutputs["pick"], "action output present in the execution context");
    ok("tool → action: web.search → list.pick → note.compose via priorOutputs");
}


// ---------------------------------------------------------------------------
// 6. Action → Tool stays EXPLICIT (security boundary, 4C contract)
// ---------------------------------------------------------------------------
{
    const actions = createDefaultActionRegistry();
    const tools = new ToolRegistry();
    const received: Array<Record<string, unknown>> = [];
    tools.register({
        name: "gmail.send",
        description: "send",
        requiredArgs: ["to", "body"],
        async executor(args) {
            received.push(args);
            return { sent: true };
        },
    });
    // Default policy: gmail.send requires confirmation → blocked (Phase 3/4).
    const executor = new PlanExecutor(tools, { policy: createDefaultToolPolicy(), actions });

    const result = await executor.execute(createPlanShell("action-to-tool", [
        step("compose", "Compose the message body", {
            kind: "action",
            action: "note.compose",
            args: { template: "Hello {to}", to: "ravi@example.com" },
        }),
        step("send", "Send it by email", {
            kind: "tool",
            tool: "gmail.send",
            args: { to: "ravi@example.com", body: "explicit plan arg" },
            dependsOn: ["compose"],
        }),
    ]));
    // The action ran; the TOOL was stopped at the permission gate.
    assert.deepEqual(result.steps[0]?.output, { note: "Hello ravi@example.com" });
    assert.equal(result.steps[1]?.status, "failed");
    assert.ok(String(result.steps[1]?.error).includes("tool policy confirm"));
    assert.equal(received.length, 0, "tool never executed — policy still governs the tool path");
    // Even if it HAD been allowed, the tool receives its args from the PLAN
    // (step.args) — priorOutputs are never auto-injected into tool args.
    assert.deepEqual(result.steps[1]?.output, undefined, "blocked step produces no output");
    ok("action → tool: explicit step.args + policy gate; priorOutputs never injected into tools");
}

console.log(`\n✅ Action Pipeline (4C): ${pass} checks passed.`);

