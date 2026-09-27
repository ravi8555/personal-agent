/**
 * Phase 2 — deterministic application-side plan validator.
 *
 * The LLM planner proposes; THIS module disposes. Checks:
 *  - every step has a non-empty unique id + non-empty goal
 *  - every dependsOn target exists
 *  - no circular dependencies (DFS over the dependsOn graph)
 *  - every referenced tool is registered (unknown tools are allowed only
 *    when explicitly listed via `allowedUnknownTools`)
 *  - tool steps declare their required args (per registry schema)
 */

import type { IPlan, IPlanStep } from "./planTypes.js";

export interface IPlanValidation {
    valid: boolean;
    errors: string[];
}

export interface IValidatorOptions {
    /** Tool names known to the registry at validation time. */
    knownTools?: string[];
    /**
     * Required args per tool, e.g. `{ "web.search": ["query"] }`.
     * A step using the tool must provide all listed args.
     */
    requiredArgs?: Record<string, string[]>;
    /** Tools the LLM may reference ahead of registry support. */
    allowedUnknownTools?: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validatePlan(plan: IPlan, options: IValidatorOptions = {}): IPlanValidation {
    const errors: string[] = [];

    if (!plan || !isRecord(plan)) {
        return { valid: false, errors: ["plan must be an object"] };
    }
    if (plan.intent !== "task") {
        errors.push(`plan.intent must be "task" (got ${JSON.stringify((plan as { intent?: unknown }).intent)})`);
    }
    if (typeof plan.goal !== "string" || !plan.goal.trim()) {
        errors.push("plan.goal must be a non-empty string");
    }
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        return { valid: false, errors: [...errors, "plan.steps must be a non-empty array"] };
    }

    const { knownTools = [], requiredArgs = {}, allowedUnknownTools = [] } = options;

    // --- ids unique + goals non-empty ---
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const s of plan.steps) {
        if (!s || typeof s.id !== "string" || !s.id.trim()) {
            errors.push("every step must have a non-empty string id");
            continue;
        }
        if (seen.has(s.id)) dupes.add(s.id);
        seen.add(s.id);
        if (typeof (s as IPlanStep).goal !== "string" || !(s as IPlanStep).goal.trim()) {
            errors.push(`step ${JSON.stringify(s.id)} must have a non-empty goal`);
        }
    }
    for (const d of dupes) errors.push(`duplicate step id: ${JSON.stringify(d)}`);

    const ids = seen;

    // --- dependsOn targets exist (+ self-dependency) ---
    for (const s of plan.steps) {
        if (!s || typeof s.id !== "string") continue;
        const deps = (s as IPlanStep).dependsOn ?? [];
        if (!Array.isArray(deps)) {
            errors.push(`step ${JSON.stringify(s.id)} dependsOn must be an array`);
            continue;
        }
        for (const d of deps) {
            if (typeof d !== "string" || !d) {
                errors.push(`step ${JSON.stringify(s.id)} has an invalid dependsOn entry`);
                continue;
            }
            if (d === s.id) errors.push(`step ${JSON.stringify(s.id)} depends on itself`);
            else if (!ids.has(d)) errors.push(`step ${JSON.stringify(s.id)} depends on unknown step ${JSON.stringify(d)}`);
        }
    }

    // --- cycle detection (DFS) ---
    const adj = new Map<string, string[]>();
    for (const s of plan.steps) {
        if (s && typeof s.id === "string") adj.set(s.id, ((s as IPlanStep).dependsOn ?? []).filter(d => ids.has(d)));
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycle: string[] = [];
    const dfs = (node: string, path: string[]): boolean => {
        if (visiting.has(node)) {
            cycle.push(...path.slice(path.indexOf(node)), node);
            return true;
        }
        if (visited.has(node)) return false;
        visiting.add(node);
        for (const next of adj.get(node) ?? []) {
            if (dfs(next, [...path, node])) return true;
        }
        visiting.delete(node);
        visited.add(node);
        return false;
    };
    for (const id of ids) {
        if (dfs(id, [])) {
            errors.push(`circular dependency detected: ${cycle.join(" -> ")}`);
            break;
        }
    }

    // --- tool allow-list + required args ---
    for (const s of plan.steps) {
        if (!s || typeof s.id !== "string") continue;
        const tool = (s as IPlanStep).tool;
        if (tool == null || tool === "") continue;
        if (typeof tool !== "string") {
            errors.push(`step ${JSON.stringify(s.id)} tool must be a string`);
            continue;
        }
        const known = knownTools.includes(tool) || allowedUnknownTools.includes(tool);
        if (!known) {
            errors.push(`step ${JSON.stringify(s.id)} references unknown tool ${JSON.stringify(tool)}`);
            continue;
        }
        const required = requiredArgs[tool] ?? [];
        const args = (s as IPlanStep).args ?? {};
        if (!isRecord(args)) {
            errors.push(`step ${JSON.stringify(s.id)} args must be an object`);
            continue;
        }
        for (const key of required) {
            const v = (args as Record<string, unknown>)[key];
            if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
                errors.push(`step ${JSON.stringify(s.id)} tool ${JSON.stringify(tool)} missing required arg ${JSON.stringify(key)}`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}
