// Phase 4A — Action Engine test (no Neo4j, no OpenAI, no network).
// Action Engine: internal agent capabilities routed by kind === "action"
// with an explicit `action` name — never ToolRegistry, never the policy.
import assert from "node:assert/strict";

import { ActionRegistry, createDefaultActionRegistry } from "../app/action/actionRegistry.js";
import { actionContextFromStep } from "../app/action/actionTypes.js";
import type { IActionContext } from "../app/action/actionTypes.js";
import { ToolRegistry } from "../app/toolRegistry.js";
import { createDefaultToolPolicy } from "../app/toolPolicy.js";
import { PlanExecutor } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";

console.log(`
=================================================
ACTION ENGINE TEST (Phase 4A)
actionTypes -> actionRegistry -> executor routing
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}


// ---------------------------------------------------------------------------
// 1. ActionRegistry basics
// ---------------------------------------------------------------------------
{
    const registry = new ActionRegistry();
    let ran = 0;
    registry.register({
        name: "demo.double",
        description: "double a number",
        execute(context: IActionContext) {
            ran++;
            return { doubled: Number(context.args["n"] ?? 0) * 2 };
        },
    });
    assert.ok(registry.has("demo.double"));
    assert.deepEqual(registry.names(), ["demo.double"]);
    const out = await registry.execute("demo.double", {
        stepId: "s", goal: "g", args: { n: 21 }, priorOutputs: {},
    }) as { doubled: number };
    assert.equal(out.doubled, 42);
    assert.equal(ran, 1);
    await assert.rejects(() => registry.execute("nope", { stepId: "s", goal: "g", args: {}, priorOutputs: {} }), /unknown action/);
    assert.throws(() => registry.register({ name: "", description: "x", execute: async () => null }), /non-empty name/);
    ok("actionRegistry: register, execute, context, unknown-action rejection");
}

// ---------------------------------------------------------------------------
// 2. Built-in actions are pure and side-effect free
// ---------------------------------------------------------------------------
{
    const registry = createDefaultActionRegistry();
    const summarized = await registry.execute("text.summarize_local", {
        stepId: "s", goal: "g", args: { text: "abcdefghij", maxLength: 4 }, priorOutputs: {},
    }) as { summary: string };
    assert.equal(summarized.summary, "abcd");
    const picked = await registry.execute("list.pick", {
        stepId: "s", goal: "g", args: { items: [1, 2, 3, 4], count: 2 }, priorOutputs: {},
    }) as { picked: number[] };
    assert.deepEqual(picked.picked, [1, 2]);
    const composed = await registry.execute("note.compose", {
        stepId: "s", goal: "shortlist coffee", args: { template: "About {goal}: {n} options" }, priorOutputs: { n: "3" },
    }) as { note: string };
    assert.equal(composed.note, "About shortlist coffee: 3 options");
    ok("actionRegistry: built-in pure actions (summarize/pick/compose)");

    const ctx = actionContextFromStep(
        step("s1", "Pick the best", { kind: "action", action: "list.pick", args: { count: 1 } }),
        { search: ["a", "b"] },
    );
    assert.equal(ctx.stepId, "s1");
    assert.equal(ctx.args["count"], 1);
    assert.deepEqual(ctx.priorOutputs, { search: ["a", "b"] });
    ok("actionTypes: actionContextFromStep carries goal, args and prior step outputs");
}


// ---------------------------------------------------------------------------
// 3. Executor routing: action → ActionRegistry, tool → ToolRegistry
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    let toolRan = 0;
    tools.register({
        name: "web.fetch",
        description: "fetch",
        requiredArgs: ["url"],
        async executor() { toolRan++; return { page: "ok" }; },
    });

    const actions = new ActionRegistry();
    let actionRan = 0;
    actions.register({
        name: "note.compose",
        description: "compose",
        execute(context) { actionRan++; return { note: String(context.args["template"] ?? "note") }; },
    });

    const executor = new PlanExecutor(tools, { policy: createDefaultToolPolicy(), actions });
    const result = await executor.execute(createPlanShell("mixed", [
        step("fetch", "Fetch the page", { kind: "tool", tool: "web.fetch", args: { url: "https://x.test" } }),
        step("compose", "Compose a note", { kind: "action", action: "note.compose", args: { template: "done" }, dependsOn: ["fetch"] }),
    ]));
    assert.equal(result.status, "completed");
    assert.equal(toolRan, 1);
    assert.equal(actionRan, 1);
    assert.deepEqual(result.steps[1]?.output, { note: "done" });
    ok("executor: tool steps use ToolRegistry, action steps use ActionRegistry");
}

// ---------------------------------------------------------------------------
// 4. Unknown actions fail safely; bare steps keep the acknowledgement
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    let toolRan = 0;
    tools.register({
        name: "web.fetch",
        description: "fetch",
        async executor() { toolRan++; return { page: "ok" }; },
    });
    const executor = new PlanExecutor(tools, { actions: createDefaultActionRegistry() });

    const missing = await executor.execute(createPlanShell("missing", [
        step("do", "Do something internal", { kind: "action", action: "demo.ghost" }),
    ]));
    assert.equal(missing.status, "failed");
    assert.ok(String(missing.steps[0]?.error).includes("unknown action"));
    assert.equal(toolRan, 0, "unknown action never touches the tool registry");
    ok("executor: unknown action fails the step instead of falling back to tools");

    const bare = await new PlanExecutor(tools).execute(createPlanShell("bare", [
        step("do", "Think it over", { kind: "action" }),
    ]));
    assert.equal(bare.status, "completed");
    assert.equal(bare.steps[0]?.kind, "action");
    ok("executor: action steps without a registry keep the safe acknowledgement");
}

// ---------------------------------------------------------------------------
// 5. Actions bypass the permission policy; tools do not
// ---------------------------------------------------------------------------
{
    const tools = new ToolRegistry();
    let sendCalled = false;
    tools.register({
        name: "gmail.send",
        description: "send",
        requiredArgs: ["to"],
        async executor() { sendCalled = true; return { sent: true }; },
    });
    const executor = new PlanExecutor(tools, {
        policy: createDefaultToolPolicy(),
        actions: createDefaultActionRegistry(),
    });

    const ran = await executor.execute(createPlanShell("internal only", [
        step("compose", "Compose a summary", { kind: "action", action: "note.compose", args: { template: "hello" } }),
    ]));
    assert.equal(ran.status, "completed");

    const blocked = await executor.execute(createPlanShell("external", [
        step("send", "Send the summary", { kind: "tool", tool: "gmail.send", args: { to: "a@b.c" } }),
    ]));
    assert.equal(blocked.status, "failed");
    assert.ok(String(blocked.steps[0]?.error).includes("tool policy confirm"));
    assert.equal(sendCalled, false);
    ok("boundary: actions bypass policy (internal), tools are gated (external)");
}

console.log(`\n✅ Action Engine: ${pass} checks passed.`);

