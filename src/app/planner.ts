/**
 * Phase 2 — LLM-backed structured planner with deterministic fallbacks.
 * `createPlan()` NEVER executes tools — it only proposes an `IPlan` which
 * the application validates (`planValidator`) before any executor runs it.
 */

import type { IIntentResult } from "./intentEngine.js";
import { createPlanShell, TASK_PLAN_THRESHOLD, PLAN_STEP_KINDS, resolveStepKind } from "./planTypes.js";
import type { IPlan, IPlanStep, PlanStepKind } from "./planTypes.js";
import { validatePlan } from "./planValidator.js";

export interface IPlannerInput {
    /** Original user message. */
    goal: string;
    intent: IIntentResult;
    /** Optional running-context text (memory-aware planning). */
    context?: string | null;
}

export interface IPlannerHooks {
    /** Override the LLM call (tests / custom planners). Raw text in. */
    generatePlan?: (prompt: string) => Promise<string | null>;
    /** Tool names valid for this deployment (validator allow-list). */
    knownTools?: string[] | (() => string[]);
    /**
     * Phase 3: required args per tool (MCP inputSchema.required lands here
     * via ToolRegistry.requiredArgsMap()). Same live-getter form as knownTools.
     */
    requiredArgs?: Record<string, string[]> | (() => Record<string, string[]>);
    /** Tools the planner may reference ahead of registry support. */
    allowedUnknownTools?: string[];
    /** Custom fallback when the LLM path is unavailable. */
    fallback?: (input: IPlannerInput) => IPlanStep[];
    /**
     * Phase 3 (3.4): full tool catalog for the LLM prompt —
     * `() => toolRegistry.listTools()` gives name + description + provenance.
     */
    toolCatalog?: ReadonlyArray<{ name: string; description: string; source?: string }> | (() => ReadonlyArray<{ name: string; description: string; source?: string }>);
    /**
     * Strict mode: when no LLM planner is available, return `llm-unavailable`
     * instead of silently degrading to the deterministic plan.
     */
    requireLlm?: boolean;
}

export interface IPlannerResult {
    plan: IPlan | null;
    /**
     * - "ok"              — a validated plan is available
     * - "below-threshold" — task intent, but confidence < TASK_PLAN_THRESHOLD
     * - "not-a-task"      — question/conversation never plan
     * - "invalid-plan"    — neither the LLM nor the fallback produced a valid plan
     * - "llm-unavailable" — strict mode (`requireLlm`) and no LLM planner configured
     */
    reason: "ok" | "below-threshold" | "not-a-task" | "invalid-plan" | "llm-unavailable";
    /**
     * Which planning path produced the plan. `"fallback"` means the LLM was
     * unavailable / failed / produced an invalid plan and the deterministic
     * rule-based planner took over — invaluable when debugging the agent.
     */
    source?: "llm" | "fallback";
    errors?: string[];
}

export const DEFAULT_ALLOWED_UNKNOWN_TOOLS = ["web.search"];

function slugify(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    return slug || "step";
}

export function normalizeSteps(raw: unknown): IPlanStep[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const used = new Set<string>();
    const steps: IPlanStep[] = [];
    for (const [index, item] of raw.entries()) {
        if (typeof item !== "object" || item === null) return null;
        const rec = item as Record<string, unknown>;
        if (typeof rec["goal"] !== "string" || !rec["goal"].trim()) return null;
        let id = typeof rec["id"] === "string" && rec["id"].trim() ? rec["id"].trim() : `step-${index + 1}`;
        id = slugify(id);
        let n = 2;
        const base = id;
        while (used.has(id)) id = `${base}-${n++}`;
        used.add(id);
        const step: IPlanStep = { id, goal: rec["goal"].trim(), status: "pending" };
        if (typeof rec["kind"] === "string" && PLAN_STEP_KINDS.includes(rec["kind"] as PlanStepKind)) {
            step.kind = rec["kind"] as PlanStepKind;
        }
        if (typeof rec["tool"] === "string" && rec["tool"].trim()) step.tool = rec["tool"].trim();
        if (typeof rec["args"] === "object" && rec["args"] !== null && !Array.isArray(rec["args"])) {
            step.args = rec["args"] as Record<string, unknown>;
        }
        if (Array.isArray(rec["dependsOn"])) {
            step.dependsOn = (rec["dependsOn"] as unknown[]).filter((d): d is string => typeof d === "string");
        }
        steps.push(step);
    }
    // Default chain: each step depends on the previous one (unless it already
    // declares dependencies) so execution order is well-defined.
    for (const [i, s] of steps.entries()) {
        if (i > 0 && (!s.dependsOn || s.dependsOn.length === 0)) s.dependsOn = [steps[i - 1]!.id];
    }
    // Normalize each step's kind so storage/reporting never relies on inference.
    for (const s of steps) s.kind = resolveStepKind(s);
    return steps;
}

/** Rule-based fallback: always-valid plan derived from intent signals. */
function fallbackPlan(input: IPlannerInput): IPlanStep[] {
    const goal = input.goal.trim() || "Handle the request";
    const signals = input.intent.signals;
    if (signals.includes("reminder-request") || /\bremind\b/.test(goal.toLowerCase())) {
        return [
            { id: "parse-request", goal: `Parse reminder request: ${goal}`, kind: "decision", status: "pending" },
            { id: "schedule", goal: "Schedule the reminder", kind: "action", dependsOn: ["parse-request"], status: "pending" },
            { id: "confirm", goal: "Confirm the scheduled reminder to the user", kind: "response", dependsOn: ["schedule"], status: "pending" },
        ];
    }
    if (signals.includes("purchase-intent") || signals.includes("recommendation-request")) {
        return [
            { id: "search", goal: `Search candidates: ${goal}`, kind: "tool", tool: "web.search", args: { query: goal }, status: "pending" },
            { id: "filter", goal: "Filter candidates against stated constraints", kind: "decision", dependsOn: ["search"], status: "pending" },
            { id: "compare", goal: "Compare the shortlisted candidates", kind: "decision", dependsOn: ["filter"], status: "pending" },
            { id: "respond", goal: "Generate the comparison response", kind: "response", dependsOn: ["compare"], status: "pending" },
        ];
    }
    return [
        { id: "understand", goal: `Understand request: ${goal}`, kind: "decision", status: "pending" },
        { id: "act", goal: "Carry out the requested action", kind: "action", dependsOn: ["understand"], status: "pending" },
        { id: "respond", goal: "Report the outcome to the user", kind: "response", dependsOn: ["act"], status: "pending" },
    ];
}

export function buildPlannerPrompt(
    input: IPlannerInput,
    knownTools: string[],
    toolCatalog: ReadonlyArray<{ name: string; description: string; source?: string }> = [],
): string {
    return [
        "You are the planning engine of a personal AI assistant.",
        "Decompose the user request into an ordered list of steps.",
        "Return STRICT JSON only, no markdown, no commentary:",
        '{"goal": string, "steps": [{"id": string, "goal": string, "tool"?: string, "args"?: object, "dependsOn"?: string[]}]}',
        toolCatalog.length
            ? `Available tools (prefer these; other tool names are allowed but flagged):\n${toolCatalog.map(tool => `- ${tool.name}${tool.source === "mcp" ? " (mcp)" : ""}: ${tool.description}`).join("\n")}`
            : `Known tools (prefer these; other tool names are allowed but flagged): ${knownTools.length ? knownTools.join(", ") : "(none - use reasoning-only steps)"}.`,
        "Rules: every step needs a unique kebab-case id and a concrete goal;",
        "declare dependsOn ids that already exist; keep the graph acyclic;",
        "reasoning-only steps omit tool/args.",
        `User request: ${input.goal}`,
        `Intent: ${input.intent.type} (confidence ${input.intent.confidence}; signals: ${input.intent.signals.join(", ") || "none"})`,
        input.context ? `Relevant memory context:\n${input.context}` : "Relevant memory context: (none)",
    ].join("\n");
}

function extractJson(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("planner LLM did not return JSON");
    return JSON.parse(text.slice(start, end + 1));
}

export class Planner {
    private readonly hooks: IPlannerHooks;

    constructor(hooks: IPlannerHooks = {}) {
        this.hooks = hooks;
    }

    public async createPlan(input: IPlannerInput): Promise<IPlannerResult> {
        if (input.intent.type !== "task") {
            return { plan: null, reason: "not-a-task" };
        }
        if (input.intent.confidence < TASK_PLAN_THRESHOLD) {
            return { plan: null, reason: "below-threshold" };
        }

        // Phase 3 (3.3/3.4): knownTools may be a live getter so tools
        // discovered from MCP servers AFTER the Agent was built still reach
        // both the validator allow-list and the planner prompt.
        const knownToolsSource = this.hooks.knownTools;
        const knownTools = typeof knownToolsSource === "function" ? knownToolsSource() : (knownToolsSource ?? []);
        const requiredArgsSource = this.hooks.requiredArgs;
        const requiredArgs = typeof requiredArgsSource === "function" ? requiredArgsSource() : (requiredArgsSource ?? {});
        const allowedUnknownTools = this.hooks.allowedUnknownTools ?? DEFAULT_ALLOWED_UNKNOWN_TOOLS;
        const catalogSource = this.hooks.toolCatalog;
        const toolCatalog = typeof catalogSource === "function" ? catalogSource() : (catalogSource ?? []);
        const goal =
            typeof input.goal === "string" && input.goal.trim() ? input.goal.trim() : "Handle the request";

        const validate = (steps: IPlanStep[]): { plan: IPlan | null; errors: string[] } => {
            const plan = createPlanShell(goal, steps);
            const validation = validatePlan(plan, { knownTools, requiredArgs, allowedUnknownTools });
            return { plan: validation.valid ? plan : null, errors: validation.errors };
        };

        // ---- 1. LLM planner (structured JSON, strict schema) ----------------
        if (this.hooks.generatePlan) {
            const prompt = buildPlannerPrompt(input, knownTools, toolCatalog);
            let steps: IPlanStep[] | null = null;
            try {
                const raw = await this.hooks.generatePlan(prompt);
                if (raw != null && raw.trim()) {
                    const parsed = extractJson(raw) as { goal?: unknown; steps?: unknown };
                    steps = normalizeSteps(parsed.steps);
                }
            } catch {
                steps = null;
            }

            if (steps) {
                const llmValidated = validate(steps);
                if (llmValidated.plan) {
                    // LLM success → ok / source: "llm"
                    return { plan: llmValidated.plan, reason: "ok", source: "llm" };
                }
                // LLM produced a structurally invalid plan → fall through to the
                // deterministic planner instead of executing something unsafe.
            }
        } else if (this.hooks.requireLlm) {
            return { plan: null, reason: "llm-unavailable" };
        }

        // ---- 2. Deterministic fallback planner ------------------------------
        const fallbackSteps = this.hooks.fallback ? this.hooks.fallback(input) : fallbackPlan(input);
        const fallbackValidated = validate(fallbackSteps);

        if (fallbackValidated.plan) {
            // Reason stays "ok" (a usable plan exists) but `source` makes the
            // degradation explicit for debugging/telemetry.
            return { plan: fallbackValidated.plan, reason: "ok", source: "fallback" };
        }

        // ---- 3. Nothing produced a valid plan -------------------------------
        const errors = fallbackValidated.errors;
        if (this.hooks.requireLlm && !this.hooks.generatePlan) {
            return { plan: null, reason: "llm-unavailable", errors };
        }
        return { plan: null, reason: "invalid-plan", source: "fallback", errors };
    }
}
