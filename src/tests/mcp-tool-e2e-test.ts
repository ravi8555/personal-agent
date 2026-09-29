// Phase 3 — MCP Tool Layer E2E test (no Neo4j, no OpenAI, no external network).
// Order mirrors 3.12: mcpTypes → mcpClient → mcpToolAdapter → discovery →
// registry → planner awareness → policy → executor → Agent E2E (3.13).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { IMcpCallResult } from "../app/mcp/mcpTypes.js";
import { InProcessMcpClient, StdioMcpClient } from "../app/mcp/mcpClient.js";
import { McpToolAdapter, unwrapMcpResult } from "../app/mcp/mcpToolAdapter.js";
import { discoverMcpTools, registerMcpTools } from "../app/mcp/mcpToolDiscovery.js";
import { McpServerManager } from "../app/mcp/mcpServerManager.js";
import { ToolRegistry, createDefaultToolRegistry } from "../app/toolRegistry.js";
import { createDefaultToolPolicy, allowAllToolPolicy } from "../app/toolPolicy.js";
import { validatePlan } from "../app/planValidator.js";
import { Planner } from "../app/planner.js";
import { PlanExecutor } from "../app/planExecutor.js";
import { createPlanShell } from "../app/planTypes.js";
import type { IPlanStep } from "../app/planTypes.js";
import { detectIntent } from "../app/intentEngine.js";
import { Agent } from "../app/agent.js";
import type { AgentResponder } from "../app/agent.js";

console.log(`
=================================================
MCP TOOL LAYER TEST (Phase 3)
mcpTypes -> mcpClient -> adapter -> discovery ->
registry -> planner -> policy -> executor -> Agent
=================================================
`);

let pass = 0;
const ok = (label: string) => { console.log(`  PASS ${label}`); pass++; };

function step(id: string, goal: string, extra: Partial<IPlanStep> = {}): IPlanStep {
    return { id, goal, status: "pending", ...extra };
}

// ---------------------------------------------------------------------------
// 1. mcpTypes + adapter (unwrap semantics)
// ---------------------------------------------------------------------------
{
    const json: IMcpCallResult = { content: [{ type: "text", text: JSON.stringify({ echoed: "hi" }) }] };
    assert.deepEqual(unwrapMcpResult(json), { echoed: "hi" });
    const plain: IMcpCallResult = { content: [{ type: "text", text: "just text" }] };
    assert.equal(unwrapMcpResult(plain), "just text");
    const multi: IMcpCallResult = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    assert.equal(unwrapMcpResult(multi), "a\nb");
    assert.throws(() => unwrapMcpResult({ content: [{ type: "text", text: "boom" }], isError: true }), /boom/);
    ok("adapter: unwrapMcpResult parses JSON, joins text, throws on isError");
}

// ---------------------------------------------------------------------------
// 2. In-process MCP client + discovery → registry (3.2/3.3)
// ---------------------------------------------------------------------------
const inProcess = new InProcessMcpClient([
    {
        definition: {
            name: "calendar.list_events",
            description: "List calendar events for a given date",
            inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
        },
        handler: args => [{ title: "Team standup", date: String(args["date"] ?? "") }],
    },
    {
        definition: {
            name: "gmail.send",
            description: "Send an email",
            inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        },
        handler: args => ({ sent: true, to: args["to"] }),
    },
]);

{
    const discovered = await discoverMcpTools(inProcess, "inproc");
    assert.deepEqual(discovered.map(d => d.name).sort(), ["calendar.list_events", "gmail.send"]);
    assert.ok(discovered.every(d => d instanceof McpToolAdapter));
    ok("discovery: tools/list becomes McpToolAdapter[] (3.3)");

    const registry = createDefaultToolRegistry();
    await registerMcpTools(registry, inProcess, "inproc");
    const calendar = registry.listTools().find(t => t.name === "calendar.list_events");
    assert.ok(calendar, "MCP tool registered");
    assert.equal(calendar.source, "mcp");
    assert.equal(calendar.server, "inproc");
    assert.deepEqual(calendar.requiredArgs, ["date"], "inputSchema.required → requiredArgs");
    const local = registry.listTools().find(t => t.name === "memory.note");
    assert.equal(local?.source, "local");
    ok("registry: MCP + local tools coexist with source/server provenance");

    // 3.6 — the registry is THE abstraction: no branching on provenance.
    const events = await registry.execute("calendar.list_events", { date: "tomorrow" }) as Array<{ title: string }>;
    assert.equal(events[0]?.title, "Team standup");
    ok("registry: execute() routes to MCP transparently (3.6 abstraction)");
}

// ---------------------------------------------------------------------------
// 3. Planner awareness (3.3/3.4): live knownTools + tool catalog prompt
// ---------------------------------------------------------------------------
{
    const registry = createDefaultToolRegistry();
    const planner = new Planner({
        knownTools: () => registry.listTools().map(t => t.name),
        requiredArgs: () => registry.requiredArgsMap(),
        toolCatalog: () => registry.listTools(),
        generatePlan: async prompt => {
            assert.ok(prompt.includes("Available tools"), "prompt lists available tools");
            assert.ok(prompt.includes("web.search"), "local tool listed");
            assert.ok(!prompt.includes("(mcp)"), "no MCP tool discovered yet");
            return JSON.stringify({
                goal: "Search and summarize",
                steps: [
                    { id: "search", goal: "Search the web", tool: "web.search", args: { query: "coffee" } },
                    { id: "summarize", goal: "Summarize the results", dependsOn: ["search"] },
                ],
            });
        },
    });
    const intent = detectIntent("Create a summary about coffee machines.");
    const before = await planner.createPlan({ goal: intent.raw, intent });
    assert.equal(before.reason, "ok", (before.errors ?? []).join(";"));
    ok("planner: knownTools/toolCatalog/requiredArgs work as live getters");

    // MCP discovery AFTER construction is visible to the same planner instance.
    await registerMcpTools(registry, inProcess, "inproc");
    let sawMcp = false;
    const plannerMcp = new Planner({
        knownTools: () => registry.listTools().map(t => t.name),
        toolCatalog: () => registry.listTools(),
        generatePlan: async prompt => {
            sawMcp = prompt.includes("calendar.list_events (mcp)");
            return JSON.stringify({
                goal: "List tomorrow's meetings",
                steps: [{ id: "get-events", goal: "List calendar events", tool: "calendar.list_events", args: { date: "tomorrow" } }],
            });
        },
    });
    const after = await plannerMcp.createPlan({ goal: "Create a summary of my meetings tomorrow.", intent });
    assert.equal(after.reason, "ok", (after.errors ?? []).join(";"));
    assert.equal(after.plan?.steps[0]?.tool, "calendar.list_events");
    assert.ok(sawMcp, "prompt must show the discovered MCP tool with (mcp) marker");
    ok("planner: MCP discovery feeds knownTools + prompt (3.3/3.4 chain)");

    // Unknown tools still rejected by the validator.
    const bad = validatePlan(
        createPlanShell("x", [step("s", "Do it", { tool: "slack.post_message" })]),
        { knownTools: registry.listTools().map(t => t.name) },
    );
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some(e => e.includes("unknown tool")));
    ok("validator: unregistered tools still rejected (MCP or not)");
}

// ---------------------------------------------------------------------------
// 4. Real stdio MCP server (scripts/mcp-echo-server.mjs) — 3.5 test.echo
// ---------------------------------------------------------------------------
const serverPath = fileURLToPath(new URL("../../scripts/mcp-echo-server.mjs", import.meta.url));
const stdioClient = new StdioMcpClient({ command: process.execPath, args: [serverPath] });
{
    await stdioClient.connect(); // initialize + notifications/initialized
    const tools = await stdioClient.listTools();
    assert.deepEqual(
        tools.map(t => t.name).sort(),
        ["calendar.list_events", "gmail.send", "test.echo", "web.search"],
    );
    ok("stdio MCP: initialize handshake + tools/list against a real child process");

    const echoed = unwrapMcpResult(await stdioClient.callTool("test.echo", { message: "ping" })) as { echoed: string };
    assert.equal(echoed.echoed, "ping");
    ok("stdio MCP: tools/call round-trip (test.echo)");
}
{
    const registry = new ToolRegistry();
    await registerMcpTools(registry, stdioClient, "echo-server");
    const events = await registry.execute("calendar.list_events", { date: "2026-09-30" }) as Array<{ title: string }>;
    assert.equal(events.length, 2);
    assert.equal(events[0]?.title, "Team standup");
    assert.deepEqual(registry.requiredArgs("calendar.list_events"), ["date"]);
    ok("stdio MCP: registered into ToolRegistry and executed through the abstraction");
}




// ---------------------------------------------------------------------------
// 5. Permission policy (3.9/3.10)
// ---------------------------------------------------------------------------
{
    const policy = createDefaultToolPolicy();
    assert.equal((await policy.canExecute("gmail.search", {})).decision, "allow");
    assert.equal((await policy.canExecute("calendar.list_events", {})).decision, "allow");
    assert.equal((await policy.canExecute("test.echo", {})).decision, "allow");
    assert.equal((await policy.canExecute("web.search", {})).decision, "allow");
    assert.equal((await policy.canExecute("gmail.send", {})).decision, "confirm");
    assert.equal((await policy.canExecute("calendar.delete_event", {})).decision, "confirm");
    assert.equal((await allowAllToolPolicy.canExecute("gmail.send", {})).decision, "allow");
    ok("policy: read-only allowed, state-changing requires confirmation, allow-all escape hatch");

    // Executor enforces the policy BEFORE the registry is touched (3.10).
    const registry = new ToolRegistry();
    let gmailCalled = false;
    registry.register({
        name: "gmail.send",
        description: "send email",
        requiredArgs: ["to"],
        async executor() { gmailCalled = true; return { sent: true }; },
    });
    registry.register({
        name: "calendar.list_events",
        description: "list events",
        requiredArgs: ["date"],
        async executor() { return [{ title: "Team standup" }]; },
    });
    const executor = new PlanExecutor(registry, { policy: createDefaultToolPolicy() });
    const blocked = await executor.execute(createPlanShell("send a mail", [
        step("send", "Send the summary email", { tool: "gmail.send", args: { to: "ravi@x.com" } }),
        step("confirm", "Confirm the email was sent", { dependsOn: ["send"] }),
    ]));
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.steps[0]?.status, "failed");
    assert.ok((blocked.steps[0]?.error ?? "").includes("tool policy confirm"), blocked.steps[0]?.error ?? "no error");
    assert.equal(blocked.steps[1]?.status, "skipped");
    assert.equal(gmailCalled, false, "policy must gate BEFORE the tool executes");
    ok("policy: blocked step fails with reason, dependents skipped, tool never called");

    const allowed = await executor.execute(createPlanShell("list events", [
        step("get", "List tomorrow's meetings", { tool: "calendar.list_events", args: { date: "tomorrow" } }),
    ]));
    assert.equal(allowed.status, "completed");
    ok("policy: allowed read-only MCP-style tool still executes normally");
}


// ---------------------------------------------------------------------------
// 6. Agent E2E (3.13): full Phase 3 chain + checklist
// ---------------------------------------------------------------------------
{
    // Registry: local tools + MCP tools from the REAL stdio server.
    const registry = createDefaultToolRegistry();
    await registerMcpTools(registry, stdioClient, "echo-server");

    // Planner: real generatePlan seam driven deterministically (no OpenAI key).
    let plannerPrompt = "";
    const planner = new Planner({
        knownTools: () => registry.listTools().map(t => t.name),
        requiredArgs: () => registry.requiredArgsMap(),
        toolCatalog: () => registry.listTools(),
        generatePlan: async prompt => {
            plannerPrompt = prompt;
            return JSON.stringify({
                goal: "Find tomorrow's meetings and summarize them",
                steps: [
                    { id: "get-events", goal: "Retrieve tomorrow's calendar events", tool: "calendar.list_events", args: { date: "tomorrow" } },
                    { id: "summarize", goal: "Summarize the retrieved meetings", dependsOn: ["get-events"] },
                    { id: "send-summary", goal: "Send the meeting summary", tool: "gmail.send", args: { to: "ravi@example.com" }, dependsOn: ["summarize"] },
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
        .withToolRegistry(registry)
        .withPlanner(planner)
        .build();

    const messages = await agent.run("Create a summary of my meetings tomorrow.");
    assert.ok(messages && messages.length > 0, "agent returned conversation messages");

    // 3.13 checklist:
    assert.equal(agent.getLastIntent()?.type, "task");                       // Intent
    ok("checklist: Intent");

    const plan = agent.getLastPlan();
    assert.ok(plan, "planner produced a plan");                              // Planner
    ok("checklist: Planner");

    assert.equal(plan.steps.length, 3);                                      // Plan validation
    assert.equal(plan.status, "failed"); // gmail.send must be policy-blocked
    ok("checklist: Plan validation");

    assert.ok(plannerPrompt.includes("calendar.list_events (mcp)"));         // MCP discovery → prompt
    ok("checklist: MCP discovery");

    const toolInfo = registry.listTools().find(t => t.name === "calendar.list_events");
    assert.equal(toolInfo?.source, "mcp");                                   // Tool registration
    ok("checklist: Tool registration");

    const result = agent.getLastPlanResult();
    assert.ok(result);
    const getEvents = result.steps.find(s => s.stepId === "get-events");
    assert.equal(getEvents?.status, "completed");                            // MCP execution
    assert.ok(JSON.stringify(getEvents?.output).includes("Team standup"), "MCP server result flowed back");
    ok("checklist: MCP execution");

    const sendStep = result.steps.find(s => s.stepId === "send-summary");
    assert.equal(sendStep?.status, "failed");
    assert.ok((sendStep?.error ?? "").includes("tool policy confirm"), sendStep?.error ?? "no error");
    ok("checklist: Execution result (policy gate visible in results)");

    assert.ok(captured.includes("[Execution]"));                             // Context injection
    assert.ok(captured.includes("Team standup"), "MCP output present in dynamic context");
    assert.ok(captured.includes("tool policy confirm"), "policy failure surfaced to the LLM");
    ok("checklist: Context injection");

    const assistant = [...messages].reverse().find(m => m.role === "assistant");
    assert.ok(assistant, "assistant response recorded");
    ok("checklist: LLM response");

    const memory = agent.getMemory().getMessages();                          // Memory recording
    assert.ok(memory.some(m => m.role === "user" && m.content.includes("summary of my meetings")));
    assert.ok(memory.some(m => m.role === "assistant"));
    ok("checklist: Memory recording (MCP result reached memory via response)");

    // Phase 3.11: MCP results become memory candidates ONLY through the
    // existing extraction pipeline — never written to Neo4j directly here.
    assert.equal(agent.getMemoryExtractions().length, 0, "no automatic memory writes from tool results");
    ok("memory boundary: MCP results flow through response → extraction, not straight to Neo4j");
}

await stdioClient.close();

console.log(`\n✅ MCP Tool Layer: ${pass} checks passed.`);

// ---------------------------------------------------------------------------
// 7. Phase 3.5/3.6 — MCP server manager + config (lifecycle, fleet, policy)
// ---------------------------------------------------------------------------
{
    const registry = createDefaultToolRegistry();
    const manager = new McpServerManager(registry);

    // Declarative config (3.6) — a fleet, not a hard-coded test script.
    const outcomes = await manager.registerAll([
        { id: "tools", command: process.execPath, args: [serverPath], timeoutMs: 8000, enabled: true },
        { id: "broken", command: process.execPath, args: ["does-not-exist.mjs"], timeoutMs: 3000, enabled: true },
        { id: "off", command: process.execPath, args: [serverPath], enabled: false },
    ]);
    assert.equal(outcomes.length, 3);
    const toolsOutcome = outcomes.find(o => o.id === "tools");
    assert.equal(toolsOutcome?.ok, true, toolsOutcome?.error ?? "no error");
    assert.deepEqual(toolsOutcome?.tools.sort(), ["calendar.list_events", "gmail.send", "test.echo", "web.search"]);
    const broken = outcomes.find(o => o.id === "broken");
    assert.equal(broken?.ok, false);
    assert.ok(broken?.error, "failing server surfaces its reason in the outcome");
    assert.equal(outcomes.find(o => o.id === "off")?.ok, true, "disabled servers are skipped, not failed");
    assert.deepEqual(manager.ids().sort(), ["tools"], "only the healthy server is managed");
    ok("manager: declarative fleet config registers healthy servers, reports failures, skips disabled");

    // Healthy servers before close; registry already holds their MCP tools.
    assert.ok(registry.listTools().some(t => t.name === "calendar.list_events" && t.source === "mcp"));
    assert.equal(manager.isHealthy("tools"), true);
    assert.equal(manager.isHealthy("broken"), false);

    // Reconnect recycles one server only; closeAll shuts everything down.
    await manager.reconnect("tools");
    assert.equal(manager.ids().includes("tools"), true);
    await manager.closeAll();
    assert.deepEqual(manager.ids(), []);
    ok("manager: reconnect recycles one server, closeAll shuts the fleet down");
}


