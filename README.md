# NeuroGraph — Personal AI Assistant

A memory-aware personal AI agent with deterministic intent detection, LLM-assisted task planning, validated execution plans, and extensible tool execution.

**NeuroGraph** builds a persistent, long-term memory of the user over time. Unlike standard conversational bots whose memory is lost across sessions or compressed into lossy flat summaries, it continuously extracts atomic facts, relations, and feedback from dialogue into an evolving property graph powered by **Neo4j**, performs proactive conflict detection and self-correction, dynamically injects relevant running context into the system prompt, and features a clean, isolated frontend UI.

The design keeps two engines strictly separate — the **Memory Engine** answers *"what do I know?"* and the **Planning Engine** answers *"what should I do?"* — and they meet only in the labelled dynamic context handed to the LLM.

## How It Works (Current App)

Every user message flows through the memory pipeline into the graph, then back into the agent:

```
User message
     ↓
Memory (sliding turn history)
     ↓
BackgroundMemoryProcessor (10-step pipeline, non-blocking)
     ↓
Extraction (summary / facts / relations / feedback)
     ↓
Normalization (entities + predicates normalized)
     ↓
Neo4j (User)-[:PREFERS|:DISLIKES|:LIKES]->(Thing) graph
     ↓
GraphKnowledgeRetriever (relevant subgraph)
     ↓
ContextWatcher (topic-aware injection)
     ↓
Running Context (Current relationship / Historical evidence / Latest evidence)
     ↓
Agent (A: memory, B: context watcher, C: running context → system prompt, D: E2E)
     ↓
LLM (response)
```

With Phases 1 + 2 the Agent turn is now routed:

```
User message
     ↓
Memory.addUser()
     ↓
Intent Detection (Phase 1)
     ↓
┌──────────────┬───────────────┬────────────────┐
│ Question     │ Task          │ Conversation   │
└──────┬───────┴──────┬────────┴───────┬────────┘
       ↓              ↓                ↓
  Retrieval +     Planner          Memory
  Context + LLM   (Phase 2)        Pipeline
                  ↓
                IPlan → PlanExecutor → Tools
                  ↓
            Dynamic Context
  [Relevant memory] / [Current task] / [Execution]
                  ↓
                 LLM
```

### Preference-change loop (conflict resolution)

```
DISLIKES coffee (stored fact)
      ↓
new statement: "I like coffee now"
      ↓
LIKES coffee (extracted)
      ↓
ConflictDetector (LIKES <-> DISLIKES, PREFERS -> DISLIKES)
      ↓
FeedbackEngine (audit trail)
      ↓
SelfCorrectionEngine (supersede stale belief)
      ↓
DISLIKES removed
      ↓
LIKES becomes current knowledge
```

Done so far: A — Agent → Memory ✅ · B — Agent → ContextWatcher ✅ ·
C — Running Context → LLM ✅ · D — Actual Agent E2E ✅ ·
Memory conflict resolution ✅ · Self correction ✅ · Neo4j graph ✅ ·
Phase 1 Intent Engine ✅ · Phase 2 Planning Engine ✅

## Phase 1 — Intent Engine

`src/app/intentEngine.ts` (pure, deterministic, no LLM, no I/O):

```
User message
     ↓
Memory.addUser()
     ↓
Intent Detection                     ← Phase 1
     ↓
┌──────────────┬───────────────┬────────────────┐
│ Question     │ Task          │ Conversation   │
└──────┬───────┴──────┬────────┴───────┬────────┘
       ↓              ↓                ↓
  Retrieval +     Planner           Memory
  Context + LLM   (Phase 2)         Pipeline
```

- **Three intents only:** `question | task | conversation` — plus rich `signals`
  (`memory-query`, `correction`, `preference`, `explicit-preference`,
  `personal-fact`, `greeting`, `acknowledgement`, `opinion`, `purchase-intent`,
  `recommendation-request`, `imperative:*`, `help-me-*`, `reminder-request`, …).
- **`IIntentResult { type, confidence, signals, raw }`** — `confidence` is a
  rule-engine score, not a probability: strong 0.90–0.97, moderate 0.75–0.89,
  fallback conversation 0.60–0.74.
- **Priority:** task > question > conversation, with two guards:
  a *memory-query* ("Do you remember…", "Remind me what…") always resolves to
  `question`, and a *correction* sentence ("Actually, I like coffee now.")
  can never leak into task/question — the conflict/self-correction pipeline is
  untouched.
- **Classification only, no routing.** Exposed via `agent.getLastIntent()` and
  injectable via `AgentBuilder.withIntentDetector()`.

## Phase 2 — Planning Engine

Plans are **transient, in-memory execution state** — the Planning Engine answers
*"what should I do?"* while the Memory Engine keeps answering *"what do I know?"*.
Neither owns the other.

```
Intent(task) + confidence ≥ 0.75
            ↓
         Planner  (LLM structured JSON, strict schema)   ← src/app/planner.ts
            ↓
          IPlan   (id, goal, steps[], createdAt, status) ← src/app/planTypes.ts
            ↓
       planValidator (ids, deps, cycles, tools, args)    ← src/app/planValidator.ts
            ↓
        PlanExecutor (dependency order, fail → skip)     ← src/app/planExecutor.ts
            ↓
        ToolRegistry (MCP-ready seam)                    ← src/app/toolRegistry.ts
            ↓
   Dynamic Context ([Relevant memory]/[Current task]/[Execution])
            ↓
                        LLM
```

### Step kinds (planner reasoning vs. agent/LLM reasoning)

Every step carries a `kind` so the executor never conflates the two:

| kind | Meaning | Resolved by |
| ---- | ------- | ----------- |
| `tool` | external capability (MCP in Phase 3) | `ToolRegistry` |
| `decision` | planner-side judgement: pick/filter/score | planner layer |
| `action` | agent-side action, no external tool | agent layer |
| `response` | final prose — **owned by the LLM** | LLM (executor only records intent) |

`resolveStepKind()` infers the kind when a plan omits it (tool → `tool`,
"report/respond…" → `response`, else `decision`).

### Planner result metadata

```ts
interface IPlannerResult {
  plan: IPlan | null;
  reason: "ok" | "below-threshold" | "not-a-task" | "invalid-plan" | "llm-unavailable";
  source?: "llm" | "fallback";   // which planner actually produced the plan
  errors?: string[];
}
```

LLM success → `ok` / `source: "llm"` · LLM missing, failing or structurally
invalid → deterministic plan with `ok` / `source: "fallback"` (the degradation is
explicit for debugging) · neither produces a valid plan → `invalid-plan`.
Strict mode (`new Planner({ requireLlm: true })`) returns `llm-unavailable`
instead of silently degrading.

### Dynamic context

`src/app/dynamicContext.ts` is the single seam where the two engines meet:

```
[Relevant memory]      ← Memory Engine (RunningContext, embedded verbatim)
- ravi LIKES coffee

[Current task]         ← Planning Engine
- Goal: Find a coffee machine
- Plan: plan-… (4 step(s), now completed)

[Execution]            ← what actually happened (kind/tool tagged)
- Search for coffee machines — done (tool "web.search"): {...}
- Plan outcome: completed

[Instruction]
- Use the execution results above to formulate the final response.
- Only describe actions that appear under [Execution]; never invent tool output.
```

So the LLM reports real execution results instead of pretending it did the work.

### Trigger & safety rules

- **Trigger gate:** Task intent **and** `confidence >= TASK_PLAN_THRESHOLD (0.75)`.
  Below the threshold the agent asks for clarification instead of guessing;
  question/conversation never reach the planner.
- **LLM proposes, the application disposes:** `planValidator` rejects duplicate
  ids, missing/cyclic dependencies, unknown tools and missing required args.
- **The LLM never executes tools** — only `PlanExecutor` calls the registry.
- **Deterministic by default in tests:** injecting `withResponder()` disables the
  LLM planner hook, so unit tests need no API key and no network.
- Seams: `withPlanner()`, `withPlanExecutor()`, `withToolRegistry()`, plus
  `getLastPlan()`, `getLastPlanResult()`, `getToolRegistry()`.

## Phase 3 — MCP Tool Layer

MCP (Model Context Protocol) is an **infrastructure/capability layer
underneath the existing ToolRegistry** — not a replacement for the Planner or
the Agent. MCP provides capabilities; the Planner decides when those
capabilities are needed.

```
                       ┌───────────────┐
                       │  Local Tools  │
                       └───────┬───────┘
                               │
Plan → Validator → Policy → Executor → ToolRegistry
                               │
                       ┌───────┴───────┐
                       │   MCP Layer   │
                       └───────┬───────┘
                               │
                  ┌────────────┼────────────┐
                  ▼            ▼            ▼
                Search       Gmail       Calendar
                Server       Server        Server
```

### Modules

| Module | Responsibility |
| ------ | -------------- |
| `src/app/mcp/mcpTypes.ts` | `IMcpClient`, `IMcpToolDefinition`, `IMcpCallResult` — the only MCP surface the app sees |
| `src/app/mcp/mcpClient.ts` | `InProcessMcpClient` (tests/demos) + `StdioMcpClient` (real JSON-RPC 2.0 over stdio: `initialize` → `tools/list` → `tools/call`) |
| `src/app/mcp/mcpToolAdapter.ts` | `McpToolAdapter implements IToolDefinition` — an MCP tool is **just a tool** to the executor |
| `src/app/mcp/mcpToolDiscovery.ts` | `discoverMcpTools()` / `registerMcpTools()` — `tools/list` → adapter → registry |
| `src/app/toolPolicy.ts` | Permission policy between validator and executor: `allow` / `confirm` / `deny` |
| `scripts/mcp-echo-server.mjs` | Minimal local MCP server (`test.echo`, `calendar.list_events`, `web.search`, `gmail.send`) used by the E2E test |

### The Phase 3 chain

```
MCP servers → tool discovery → ToolRegistry.listTools()
            → knownTools/toolCatalog (live getters) → Planner prompt
            → IPlan → PlanValidator → Permission Policy → PlanExecutor
            → ToolRegistry.execute() → MCP → results → [Execution] → LLM
```

### Key guarantees

- **3.6 Registry = abstraction:** no `if (tool === "gmail.search")` anywhere —
  the executor only ever calls `registry.execute(step.tool, step.args)`.
- **3.9/3.10 Security boundary:** `LLM → Planner → Validator → Permission →
  Executor → Registry → MCP`. The LLM never calls MCP directly; `gmail.send` /
  `calendar.delete_event` are blocked with an explicit `tool policy confirm`
  reason (approval UX arrives in Phase 4) — proven in tests that the tool is
  **never invoked** when blocked.
- **3.3/3.4 Dynamic discovery:** `knownTools`, `requiredArgs` and `toolCatalog`
  are **live getters** — MCP tools registered after `build()` are immediately
  visible to the planner prompt (marked `(mcp)`) and to the validator
  allow-list (including `inputSchema.required` → required args).
- **3.11 Memory boundary:** MCP results flow through the response → existing
  extraction/conflict pipeline; they are never written straight to Neo4j.
- Seams: `withToolPolicy()`; registry provenance via `listTools()`
  (`source: "local" | "mcp"`, `server`).

## Phase 3.5 — MCP Server Manager (lifecycle) + Config

Phase 3 left two production gaps (per design review): the `skipped`-vs-`failed`
semantic mismatch, and MCP server lifecycle. Both are fixed here.

**1. Skipped steps are skipped, not failed.** `PlanStepStatus` gained a
`"skipped"` value; when a dependency fails (or is itself skipped), the
dependent step is recorded as `skipped` on **both** the plan and the
`IStepResult` — the internal state and execution result are now consistent,
and skips propagate transitively.

**2. Fleet lifecycle manager.** Real deployments run many MCP servers, so one
owner now manages them all — outside the Agent:

| Module | Responsibility |
| ------ | -------------- |
| `src/app/mcp/mcpServerManager.ts` | `McpServerManager` — per-id `addServer()` (connect → discover → register), `registerAll()` with per-server outcomes (a broken server never takes down Gmail/Calendar/the Agent), `reconnect()`, `isHealthy()`, `getClient()`, `closeAll()` for app exit |
| `IMcpServerConfig` | Declarative server config: `{ id, command, args?, env?, enabled?, timeoutMs? }` — disabled servers are skipped, never failed |

Chain preserved exactly:

```
MCP configuration → McpServerManager → StdioMcpClient → discover → ToolRegistry
```

Never `LLM → MCP` or `Planner → MCP` — the path stays
`Planner → Plan → Validator → Policy → Executor → Registry → Adapter → MCP`.

## Phase 4A — Action Engine (internal capabilities)

Phase 3 has `Planner → Executor → Registry → MCP` for *external* capabilities.
Phase 4 needs the mirror concept: an Agent Action that requires **no** MCP
tool at all — the `action` kind you already model:

| Step kind | Engine | Gating |
| --------- | ------ | ------ |
| `tool` | ToolRegistry (MCP) | permission policy |
| `decision` | Planner layer | structural validation |
| **`action`** | **ActionRegistry** | **none — internal only** |
| `response` | LLM | prompt-context labelling |

- `src/app/action/actionTypes.ts` — `IActionDefinition { name, description, execute(ctx) }`, `IActionContext { stepId, goal, args, priorOutputs }`, `actionContextFromStep()`.
- `src/app/action/actionRegistry.ts` — `ActionRegistry` (register/has/get/names/execute) + `createDefaultActionRegistry()` with pure built-ins: `text.summarize_local`, `list.pick`, `note.compose`.
- `IPlanStep.action?` — optional explicit routing; `normalizeSteps()` preserves it.
- `PlanExecutor` resolves named action steps through the registry with full
  prior-output context; the **legacy `runActionStep` hook still wins** when
  provided, and steps without a registry keep the safe acknowledgement.
- Seams: `withActionRegistry()`, `executor.withActions()`, `hooks.actions`,
  `getActionRegistry()` — the default Agent wires the built-ins, so
  action-capable plans execute end-to-end with zero MCP involvement.

### 4B — Action-aware Planner

The LLM planner now understands internal capabilities **explicitly**,
mirroring every live-getter concept already used for tools:

- **`actionCatalog`** — `() => actionRegistry.entries()` renders a dedicated
  prompt section so the model can't confuse the two engines:

  ```
  Available tools (…):
  - web.search: Search the web

  Available actions (internal, no approval needed; reference by "action" + "kind": "action"):
  - text.summarize_local: Deterministic local summarizer
  - list.pick: Pick items from a list
  ```

- **`knownActions`** — validator allow-list for steps that carry an
  `action` name (unknown actions are rejected → LLM plan falls back, exactly
  like unknown tools). Anonymous action steps stay valid, so legacy plans
  are unaffected; the allow-list is opt-in — **design lock:** empty
  `knownActions` means *don't enforce*, keeping `ActionRegistry` (runtime
  capability) separate from `knownActions` (planner validation boundary).
  The normal Agent path is effectively strict anyway because it always
  wires `knownActions: () => actionRegistry.names()`.
- **Prompt schema** now advertises `"action"?: string` and the rule
  *tool steps name a tool; action steps name an action*.
- **Live getters**: actions registered after `build()` are visible to both
  prompt and validator — same pattern as `knownTools`/`requiredArgs`/
  `toolCatalog`.
- **4D prep:** `IStepResult.action` records the action name, so execution
  bullets render `action "text.summarize_local"` — canonical source data
  for the upcoming MemoryCandidate stage.
- Test: `npm run test:planner-actions` — 11 checks (prompt section,
  validator allow-list, live getters, LLM action plan → Agent E2E →
  `[Execution]` → conversation memory, no Neo4j write).

### 4C — Action data-flow (priorOutputs)

Data flow, not more actions. The boundary stays explicit — nothing is ever
auto-injected:

```
args          = planner-provided inputs (declared in the plan)
priorOutputs  = execution-context inputs (COMPLETED steps, keyed by step id)
```

`PlanExecutor` accumulates outputs of completed steps and hands each action a
**deep-cloned** view (`structuredClone`), so a later action mutating its
context can never corrupt the canonical step result or earlier outputs.

Acceptance criteria proven by `npm run test:pipeline` (7 checks):

1. **Sequential** `A → B` — B receives `priorOutputs.A`; B's `args` stay
   exactly what the planner wrote.
2. **Multi-step** `A → B → C` — C receives **both** `{A, B}` (accumulated
   context, not just the previous step).
3. **Dependency-aware fan-in** `A ─┐ ├→ C` — C receives each required branch;
   context is **forward-only** (C never sees steps that had not yet run).
4. **Output isolation** — an action that deliberately mutates its
   `priorOutputs` view leaves the canonical step result and downstream
   consumers untouched.
5. **Tool → action** — `web.search → list.pick → note.compose`: the action
   reads the tool's output via `args.from` **through `priorOutputs`**.
6. **Action → tool stays explicit** — the tool receives `step.args` only and
   remains behind the permission gate (`gmail.send` → `tool policy confirm`);
   `priorOutputs` are never injected into tool args.
7. `note.compose` resolution order: explicit `args` → `priorOutputs[stepId]` →
   nested fields of prior outputs; unresolvable placeholders render empty
   (no fabrication).

Layout now matches the recommended Phase 4 structure:
`action/actionTypes.ts` · `action/actionRegistry.ts` · `action/defaultActions.ts`

### 4D — Unified Execution Result → MemoryCandidate

`IPlanExecutionResult` stays the **root object** and is now the *only* canonical
machine-readable source. One result model for all step kinds — deliberately
**no** `IToolExecutionResult` / `IActionExecutionResult` / `IDecisionExecutionResult`.

| Component | Responsibility |
| --------- | -------------- |
| Planner | decide what steps should happen |
| Validator | validate the proposed plan |
| Permission Policy | gate external tools |
| PlanExecutor | execute steps |
| ToolRegistry | execute external tools |
| ActionRegistry | execute internal actions |
| **IPlanExecutionResult** | **canonical record of execution** |
| **ExecutionResultProcessor** | **execution → memory candidates** |
| Memory Extraction → Conflict → Feedback → Neo4j | later phases (4E+) |

**Provenance (4D.2):** `IStepResult` gained `args?: Record<string, unknown>`
alongside the existing `tool?` / `action?`. `args` is **internal provenance
only** — tool/action arguments are never turned into memory automatically
(`gmail.send`, `calendar.delete`, `web.search` query text are not facts).

**The boundary (4D.3):**

```
IStepResult       → "What happened during execution?"      (execution truth)
MemoryCandidate   → "What might be worth remembering?"     (interpretation)
```

`IMemoryCandidate { source: "execution", planId, stepId, kind, tool?, action?, goal, content }`
— called *candidate* on purpose: eligibility is structural; whether it becomes
a fact is decided later by extraction/conflict.

**Eligibility rules (4D.6) — deterministic:**

| Step | Default |
| ---- | ------- |
| completed `tool` + output | ✅ candidate |
| completed `action` + output | ✅ candidate |
| completed `decision` + output | ✅ candidate (kind preserved — a planner decision is not necessarily a user fact) |
| completed `response` | ❌ no automatic candidate (generated language ≠ new information) |
| failed (any kind) | ❌ never |
| skipped | ❌ never (Phase 3.5 semantics) |
| completed w/o output | ❌ never |

All four are configurable via `ICandidateEligibility`
(`includeTools` / `includeActions` / `includeDecisions` / `includeResponses`).

**Presentation stays separate (4D.8):**

```
IPlanExecutionResult ─┬─► summarizeExecution() ─► [Execution] ─► LLM   (presentation)
                      └─► ExecutionResultProcessor ─► MemoryCandidate[] (machine source)
```

**No Neo4j from 4D (4D.10):** `src/app/execution/` is statically verified to
contain no `neo4j` / `MemoryStore` / `graphStore` / `openai` references in code
(comments document the boundary; assertions scan the stripped code), so the
Phase 3.11 guarantee holds: MCP/tool results reach the graph **only** through
the existing extraction → conflict → feedback pipeline.

Test: `npm run test:execution` — 18 checks (your 15-item matrix: canonical
envelope, tool/action/decision/response provenance, eligibility, output
preservation, plan/step provenance, presentation separation, memory + MCP
boundary).

### 4E — Memory Extraction (the semantic boundary)

4D answered *which execution outputs are candidates*; 4E answers *what
facts/relations can actually be extracted from them*.

```
4D   IPlanExecutionResult → IMemoryCandidate[]        (structural, deterministic)
                    ── 4E.1–4E.9 boundary ──
4E   IMemoryCandidate → ICandidateMemoryExtractor → IMemoryFact[]   (semantic, confidence)
                    ── 4F+ ──
     Conflict Detection → Feedback → Neo4j
```

**4E.1 Input frozen** — the extractor receives **only** `IMemoryCandidate`.
Never `IPlanExecutionResult` / `IStepResult`, ToolRegistry, ActionRegistry,
MemoryStore or the Neo4j driver (statically enforced in tests).

**4E.2 Types** (`src/app/memory/extractionTypes.ts`):

```ts
IMemoryFact      = { subject, predicate, object, confidence,
                     source:"execution", planId, stepId, kind, tool?, action? }
ICandidateExtraction = { source, planId, stepId, facts[], rawCandidate }
```

`MemoryCandidate` = structured output → `MemoryFact` = semantic interpretation.

**4E.3 Provider-independent interface:** `ICandidateMemoryExtractor.extract(candidate)`.
Implementations: `DeterministicMemoryExtractor` (now) / LLM + hybrid (later) —
never hard-wired to a provider, never given a wider input.

**4E.4 Deterministic rules first:** `MemoryExtractor` runs an ordered rule list
(`createDefaultExtractionRules()`). A candidate with no matching rule yields
**zero facts** — *structured output does not automatically equal memory.*

| Candidate | Result |
| --------- | ------ |
| `calendar.list_events` → `[{title,time}]` | `HAS_EVENT` + `OCCURS_AT` facts (from **output**, never from `date=tomorrow` args) |
| explicit `{subject,predicate,object}` output (e.g. `preference.record`) | passthrough fact |
| `list.pick` → `{picked:[…]}` | **zero facts** — a pick is not a preference |
| `web.search` / `text.summarize_local` | **zero facts** — references/summaries are not user facts |
| `decision` | conservative — **zero facts**, `kind:"decision"` preserved (agent decision ≠ user fact) |

**4E.8 Confidence** lives at *this* layer only (deterministic values, e.g.
`0.7` / `0.6` / `0.85`, clamped to `[0,1]`); 4D candidates carry no confidence.

**4E.9 No persistence:** `src/app/memory/` is statically verified (comments
stripped) to contain **no** `neo4j` / `MemoryStore` / `ConflictDetector` /
`FeedbackEngine` / `openai` / registry references, and the input surface is
never widened to `IPlanExecutionResult`. Extraction output is `IMemoryFact[]`;
4F+ owns conflict → feedback → Neo4j.

Test: `npm run test:extraction` — 14 checks (candidate boundary, tool/action/
decision extraction, upstream exclusions, provenance, no-fabrication, args
never become facts, confidence, determinism, no-Neo4j, E2E).


## Phase-wise Roadmap

| Phase | Name | Scope | Status |
| ----- | ---- | ----- | ------ |
| 1 | Intent Engine | Question / Task / Conversation + signals; classification only | ✅ Done |
| 2 | Planning Engine | `IPlan` + dependencies, validator, executor, MCP-ready tool registry | ✅ Done |
| 3 | MCP Tool Layer | Local + MCP tools behind one registry, discovery, adapter, stdio client, permission policy | ✅ Done |
| 4 | Action + Memory | Execute actions, store results back into the graph | Planned |
| 5 | User Preferences | Durable preference model with precedence over generic facts | Planned |
| 6 | Proactive Agent | Scheduled nudges from graph state + feedback loop | Planned |

Target shape:

```
                         PERSONAL AGENT
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
             INPUT LAYER                 MEMORY ENGINE
                 │                           │
          Intent Detection              Short-term Memory
                 │                           │
             Planner                   Extraction
                 │                           │
                 │                     Normalization
                 │                           │
                 │                        Neo4j
                 │                           │
                 │                     Conflict Detection
                 │                           │
                 │                     Self Correction
                 │                           │
                 │                    Context Retrieval
                 │                           │
                 └─────────────┬─────────────┘
                               ↓
                        Context Builder
                               ↓
                         Decision Engine
                               │
                ┌──────────────┼──────────────┐
                ↓              ↓              ↓
              LLM             MCP          Memory
                │              │
                │        ┌─────┼─────┐
                │        ↓     ↓     ↓
                │      Gmail Calendar GitHub
                │
                └──────────────┬──────────────┘
                               ↓
                            Response
                               ↓
                         Action Result
                               ↓
                         Memory Update
```

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Key Features](#architecture--key-features)
  - [1. Continuous Memory Pipeline](#1-continuous-memory-pipeline)
  - [2. Knowledge Graph & Schema (Neo4j)](#2-knowledge-graph--schema-neo4j)
  - [3. Conflict Detection & Self-Correction](#3-conflict-detection--self-correction)
  - [4. Context Watcher & Dynamic Prompt Injection](#4-context-watcher--dynamic-prompt-injection)
  - [5. Isolated Frontend UI](#5-isolated-frontend-ui)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Environment Configuration](#environment-configuration)
- [Getting Started](#getting-started)
  - [Backend & Agent Setup](#backend--agent-setup)
  - [Frontend Setup](#frontend-setup)
- [Scripts & Commands](#scripts--commands)
- [Testing & Validation](#testing--validation)
- [License](#license)

---

## Overview

Traditional AI assistants suffer from context window constraints and memory degradation. NeuroGraph decouples conversation from durable storage:

1. **Conversations are transient**, but structured knowledge is **permanent and normalized**.
2. **Background scheduling** extracts memory out-of-band without blocking user chat responses.
3. **Graph-based relations** (`User -[PREFERS]-> Coffee`) replace unstructured text dumps.
4. When preferences or facts change (e.g. switching from tea to coffee), **conflict detection** resolves discrepancies and supersedes stale beliefs while preserving feedback audit trails.
5. In upcoming turns, the **Context Watcher** detects the conversation topic and pulls in relevant subgraphs into the agent's running context.

---

## Architecture & Key Features

```
┌────────────────────────────────────────────────────────┐
│                   NeuroGraph Frontend                  │
│       React 18 + TypeScript + Vite (Isolated UI)       │
│  - Grok-style single-fold chat                         │
│  - Light / Dark theming                                │
│  - Privacy choices & Cookie consent modal              │
│  - Terms of Service & Privacy Policy dialogs           │
└───────────────────────────┬────────────────────────────┘
                            │ (Future API Bridge)
┌───────────────────────────▼────────────────────────────┐
│                    NeuroGraph Core                     │
│               Agent & Execution Runtime                │
│  - AgentBuilder with tool and interceptor support      │
│  - Tool calling execution loop (e.g., Weather, CLI)    │
│  - Interceptor hooks for conversation auditing         │
└─────────────┬───────────────────────────┬──────────────┘
              │                           │
  [Inbound / Outbound turns]   [Context Watcher & Retrieval]
              │                           ▲
┌─────────────▼─────────────┐             │
│  Memory & Processor Queue │             │ (Injects relevant
│  - Sliding turn history   │             │  knowledge graph context)
│  - Background scheduler   │             │
└─────────────┬─────────────┘             │
              │ (Periodic cycle)          │
┌─────────────▼─────────────┐             │
│    Memory Extraction      │             │
│  - Summaries              │             │
│  - Atomic facts           │             │
│  - Normalized relations   │             │
│  - User feedback signals  │             │
└─────────────┬─────────────┘             │
              │                           │
┌─────────────▼─────────────┐             │
│ Conflict Engine & Graph   │             │
│  - Predicate normalization│             │
│  - Conflict detection     │             │
│  - Self-correction        │─────────────┘
│  - Neo4j Property Graph   │
└───────────────────────────┘

### 1. Continuous Memory Pipeline
- **Memory Processor & Scheduler**: Conversation turns are collected in-memory. A background scheduler periodically passes unprocessed turns through an LLM extraction pipeline.
- **Extraction Artifacts**: Produces conversation summaries, discrete atomic facts, structured subject-predicate-object relations, and explicit user feedback markers (likes/dislikes, corrections).

### 2. Knowledge Graph & Schema (Neo4j)
Knowledge is mapped into a graph schema (`docs/GRAPH_SCHEMA.md`):
- **Nodes**:
  - `(:Entity {name, type})` — People, places, tools, and concepts (keyed by normalized lowercase representation).
  - `(:Fact {text, extractedAt})` — Atomic factual statements.
  - `(:Summary {summaryId, text})` — Extracted conversation block summaries.
  - `(:Feedback {feedbackId, feedbackType, details})` — User feedback signals.
- **Relationships**:
  - `(:Entity)-[:RELATES_TO {predicate, confidence, extractedAt}]->(:Entity)`
  - `(:Fact)-[:ABOUT]->(:Entity)`
  - `(:Summary)-[:ABOUT]->(:Entity)`
  - `(:Feedback)-[:ABOUT]->(:Entity)`
- **Normalization**: Canonicalizes messy natural language predicates (e.g. `"enjoys"`, `"likes"`, `"fancies"` → `LIKES`; `"lives in"` → `LIVES_IN`).

### 3. Conflict Detection & Self-Correction
- Checks incoming normalized relations against existing facts and relationships in Neo4j.
- Detects contradictions (e.g., opposing predicates or mutually exclusive attributes like `User LIKES Tea` vs `User LIKES Coffee`).
- Applies self-correction rules to retire or supersede outdated relations while retaining historical context and feedback.

### 4. Context Watcher & Dynamic Prompt Injection
- Evaluates the user's latest inputs to detect active conversation topics and referenced entities.
- Traverses the Neo4j graph to fetch relevant facts and relations.
- Generates a concise `RunningContext` block injected directly into the LLM system prompt.

### 5. Isolated Frontend UI
- Located in `frontend/`, designed as a clean, single-fold, scroll-free conversational experience.
- Complete separation of concerns: runs standalone with a mock preview echo, ready to hook into backend endpoints.
- Features: Light/Dark theming, Cookie Banner toast, Privacy Choices modal with per-category controls, and Legal Modals for Terms and Privacy.

---

## Project Structure

```
Personal-Agent/
├── .env.example               # Template for environment configuration
├── README.md                  # Project overview and guide
├── package.json               # Backend / Agent SDK dependencies & scripts
├── tsconfig.json              # TypeScript configuration (excluding frontend)
├── docs/
│   └── GRAPH_SCHEMA.md        # Formal Neo4j schema specification & DDL
├── src/
│   ├── index.ts               # Demo entry point demonstrating Agent run & memory cycle
│   ├── app/
│   │   ├── agent.ts           # Core Agent & AgentBuilder classes
│   │   ├── backgroundMemoryProcessor.ts # Out-of-band memory queue
│   │   ├── backgroundScheduler.ts       # Periodic background tick runner
│   │   ├── config.ts          # Prompts and system configuration
│   │   ├── conflictDetector.ts# Contradiction and conflict detection
│   │   ├── contextWatcher.ts  # Topic analysis and context watching
│   │   ├── feedbackEngine.ts  # Extraction and tracking of user feedback
│   │   ├── graphCypher.ts     # Cypher queries for Neo4j operations
│   │   ├── graphNormalization.ts # Canonicalization for predicates & entities
│   │   ├── graphRetrieval.ts  # Graph traversal and retrieval algorithms
│   │   ├── graphSchema.ts     # Schema definitions and DDL initialization
│   │   ├── dynamicContext.ts  # Phase 2: labelled dynamic context (memory/task/execution/instruction)
│   │   ├── graphStore.ts      # Neo4j database driver and session management
│   │   ├── intentEngine.ts    # Phase 1: Intent classification (question/task/conversation) + signals
│   │   ├── memory.ts          # Conversation turn history management
│   │   ├── memoryExtraction.ts# LLM-based structured extraction
│   │   ├── memoryProcessor.ts # Pipeline orchestrator for turn extraction
│   │   ├── memoryScheduler.ts # Scheduled processor trigger
│   │   ├── planner.ts         # Phase 2: LLM-backed structured planner (+ deterministic fallback)
│   │   ├── planTypes.ts       # Phase 2: IPlan / IPlanStep / statuses / threshold
│   │   ├── planValidator.ts   # Phase 2: deterministic plan validator (ids, deps, cycles, tools, args)
│   │   ├── planExecutor.ts    # Phase 2: dependency-ordered executor (fail → skip dependents)
│   │   ├── toolRegistry.ts    # Phase 2/3: tool registry — local + MCP behind ONE abstraction
│   │   ├── toolPolicy.ts      # Phase 3: permission policy (allow/confirm/deny) before tool calls
│   │   ├── mcp/               # Phase 3: MCP boundary
│   │   │   ├── mcpTypes.ts        # IMcpClient / IMcpToolDefinition / IMcpCallResult
│   │   │   ├── mcpClient.ts       # InProcessMcpClient + StdioMcpClient (JSON-RPC 2.0 stdio)
│   │   │   ├── mcpToolAdapter.ts  # MCP tool → IToolDefinition (looks local to the executor)
│   │   │   └── mcpToolDiscovery.ts# tools/list → adapters → ToolRegistry
│   │   ├── action/              # Phase 4A/4C: Action Engine (internal capabilities)
│   │   │   ├── actionTypes.ts       # IActionDefinition / IActionContext (args vs priorOutputs)
│   │   │   ├── actionRegistry.ts    # ActionRegistry
│   │   │   └── defaultActions.ts    # pure built-ins (summarize/pick/compose)
│   │   ├── execution/           # Phase 4D: canonical execution → candidates
│   │   │   ├── executionResultTypes.ts     # IMemoryCandidate / eligibility
│   │   │   └── executionResultProcessor.ts # IPlanExecutionResult → candidates (no Neo4j)
│   │   ├── memory/              # Phase 4E: semantic extraction → facts
│   │   │   ├── extractionTypes.ts          # IMemoryFact / ICandidateExtraction / extractor iface
│   │   │   ├── memoryExtractor.ts          # rule engine + default deterministic rules
│   │   │   └── deterministicMemoryExtractor.ts # no-LLM implementation (confidence here)
│   │   ├── runningContext.ts  # System prompt context builder
│   │   └── selfCorrection.ts  # Graph update logic for resolving conflicts
│   └── tests/                 # Unit, integration, and E2E test suites
└── frontend/                  # Isolated React UI
    ├── package.json           # Frontend dependencies & scripts
    ├── vite.config.ts         # Vite bundler configuration
    ├── index.html             # Application HTML shell
    ├── public/
    │   └── assets/            # Static assets (SVG logo, etc.)
    └── src/
        ├── main.tsx           # React root
        ├── App.tsx            # Main layout wrapper
        ├── styles.css         # Themed CSS system (Light/Dark tokens)
        ├── components/        # Header, Logo, ThemeToggle, CookieBanner, Modals
        ├── context/           # ThemeContext, ConsentContext
        └── pages/             # Home (Chat), PrivacyPolicy, Terms
```

```

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **Neo4j Database**: local Docker `neo4j:5-community` (see `docker-compose.yml`) or a cloud-hosted Neo4j AuraDB instance
- **Docker**: for the local `neo4j-community` container (ports 7474 browser, 7687 bolt)
- **OpenAI API Key**: Required for memory extraction and response generation

---

## Environment Configuration

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

For **local Docker** development, copy the local template instead:

```bash
cp .env.local .env
# .env.local points at bolt://localhost:7687 (neo4j/neurograph-local)
```

Set the appropriate credentials:

```env
# Neo4j Connection
NEO4J_URI=neo4j+s://<your-database-id>.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=<your-database-password>
NEO4J_DATABASE=neo4j

# OpenAI API Key
OPENAI_API_KEY=sk-...
```

---

## Getting Started

### Backend & Agent Setup

1. **Install backend dependencies:**
   ```bash
   npm install
   ```

2. **Verify TypeScript compilation:**
   ```bash
   npm run typecheck
   npm run build
   ```

3. **Run the agent demo:**
   ```bash
   node --env-file=.env dist/index.js
   ```

### Frontend Setup

1. **Navigate to the frontend directory and install dependencies:**
   ```bash
   cd frontend
   npm install
   ```

2. **Start the local development server:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

3. **Build the frontend for production:**
   ```bash
   npm run build
   ```
   The compiled bundle will be output to `frontend/dist/`.

---

## Scripts & Commands

### Root (Backend / SDK)

| Command | Description |
|---|---|
| `npm run build` | Compiles TypeScript sources (`src/`) to JavaScript (`dist/`) |
| `npm run typecheck` | Type-checks the backend codebase using `tsconfig.json` |
| `npm run test:connection` | Tests Neo4j connectivity using credentials in `.env` |
| `npm run test:neo4j` | Runs the Neo4j memory store test suite |
| `npm run test:intent` | Runs the Phase 1 Intent Engine + Agent wiring tests |
| `npm run test:planner` | Runs the Phase 2 Planning Engine test suite |
| `npm run test:mcp` | Runs the Phase 3 MCP Tool Layer E2E suite (spawns the local MCP echo server) |
| `npm run test:action` | Runs the Phase 4A Action Engine test suite (no Neo4j / OpenAI needed) |
| `npm run test:planner-actions` | Runs the Phase 4B Action-aware Planner test suite (no Neo4j / OpenAI needed) |
| `npm run test:pipeline` | Runs the Phase 4C Action data-flow (priorOutputs) test suite (no Neo4j / OpenAI needed) |
| `npm run test:execution` | Runs the Phase 4D Unified Execution Result → MemoryCandidate test suite (no Neo4j / OpenAI needed) |
| `npm run test:extraction` | Runs the Phase 4E Memory Extraction test suite (no Neo4j / OpenAI needed) |

### Frontend (`frontend/`)

| Command | Description |
|---|---|
| `npm run dev` | Launches the Vite dev server with hot module replacement (HMR) |
| `npm run build` | Runs typecheck (`tsc --noEmit`) and compiles the production bundle |
| `npm run typecheck` | Validates TypeScript types across all React components |
| `npm run preview` | Serves the production build locally for verification |

---

## Testing & Validation

Test scripts for backend subsystems are located in `src/tests/` and can be run using Node's loader with tsx:

- **Neo4j Connectivity:**
  ```bash
  npm run test:connection
  ```
- **Phase 1 — Intent Engine (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:intent
  ```
- **Phase 2 — Planning Engine (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:planner
  ```
- **Phase 3 — MCP Tool Layer (no Neo4j / OpenAI needed; spawns a local MCP server):**
  ```bash
  npm run test:mcp
  ```
- **Phase 4A — Action Engine (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:action
  ```
- **Phase 4B — Action-aware Planner (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:planner-actions
  ```
- **Phase 4C — Action data-flow / priorOutputs (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:pipeline
  ```
- **Phase 4D — Unified Execution Result → MemoryCandidate (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:execution
  ```
- **Phase 4E — Memory Extraction (no Neo4j / OpenAI needed):**
  ```bash
  npm run test:extraction
  ```
- **Store Operations:**
  ```bash
  npm run test:neo4j
  ```
- **Context Watcher Test:**
  ```bash
  node --env-file=.env --loader tsx src/tests/context-watacher-test.ts
  ```
- **Conflict Detection & Self-Correction:**
  ```bash
  node --env-file=.env --loader tsx src/tests/confict-detect-test.ts
  node --env-file=.env --loader tsx src/tests/self-correction-neo4j-test.ts
  ```
- **End-to-End Memory Lifecycle:**
  ```bash
  node --env-file=.env --loader tsx src/tests/final-memory-e2e-test.ts
  ```

---

## License

ISC

