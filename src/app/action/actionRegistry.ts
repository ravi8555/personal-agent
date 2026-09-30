/**
 * Phase 4A (4.1) — ActionRegistry: named internal agent capabilities.
 *
 * Mirrors ToolRegistry's shape on purpose, so the PlanExecutor treats both
 * uniformly … except the policy gate, which applies to tools only.
 */
import type { IActionContext, IActionDefinition } from "./actionTypes.js";

export class ActionRegistry {
    private readonly actions = new Map<string, IActionDefinition>();

    /** Register (or replace) an internal action. Names are matched exactly. */
    public register(action: IActionDefinition): void {
        if (!action || typeof action.name !== "string" || !action.name.trim()) {
            throw new Error("ActionRegistry.register: action must have a non-empty name");
        }
        if (typeof action.execute !== "function") {
            throw new Error(`ActionRegistry.register: action ${JSON.stringify(action.name)} must have an execute function`);
        }
        this.actions.set(action.name, action);
    }

    public has(name: string): boolean {
        return this.actions.has(name);
    }

    public get(name: string): IActionDefinition | undefined {
        return this.actions.get(name);
    }

    public names(): string[] {
        return [...this.actions.keys()];
    }

    /** Name + description descriptors — feeds the planner's action catalog (4B). */
    public entries(): Array<{ name: string; description: string }> {
        return [...this.actions.values()].map(action => ({
            name: action.name,
            description: action.description,
        }));
    }

    /** Execute a registered internal action (throws for unknown actions). */
    public async execute(name: string, context: IActionContext): Promise<unknown> {
        const action = this.actions.get(name);
        if (!action) throw new Error(`ActionRegistry.execute: unknown action ${JSON.stringify(name)}`);
        return action.execute(context);
    }
}

/** Default registry: safe built-in actions only (pure computation). */
export function createDefaultActionRegistry(): ActionRegistry {
    const registry = new ActionRegistry();

    registry.register({
        name: "text.summarize_local",
        description: "Deterministic local summarizer (first N chars, no LLM).",
        execute(context) {
            const text = String(context.args["text"] ?? "");
            const max = typeof context.args["maxLength"] === "number" ? context.args["maxLength"] : 200;
            return { summary: text.slice(0, max) };
        },
    });

    registry.register({
        name: "list.pick",
        description: "Pick the first N items from an array in the action args.",
        execute(context) {
            const items = Array.isArray(context.args["items"]) ? context.args["items"] as unknown[] : [];
            const count = typeof context.args["count"] === "number" ? context.args["count"] : 3;
            return { picked: items.slice(0, count) };
        },
    });

    registry.register({
        name: "note.compose",
        description: "Compose a working note from a template + args (no Neo4j write).",
        execute(context) {
            const template = String(context.args["template"] ?? "{goal}");
            const rendered = template.replace(/\{(\w+)\}/g, (_match: string, key: string) => {
                if (key === "goal") return context.goal;
                const value = context.args[key] ?? context.priorOutputs[key];
                return typeof value === "string" ? value : JSON.stringify(value ?? "");
            });
            return { note: rendered };
        },
    });

    return registry;
}