/**
 * Phase 4A/4C — built-in internal actions (pure, side-effect free).
 *
 * Split out of actionRegistry.ts to match the recommended Phase 4 layout:
 *   action/actionTypes.ts · action/actionRegistry.ts · action/defaultActions.ts
 *
 * No Neo4j, no network, no MCP — an action produces information; whether it
 * becomes memory is decided later by the Memory Engine (4E).
 */
import { ActionRegistry } from "./actionRegistry.js";

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
        description: "Pick the first N items from args.items, or from a prior step's output via args.from.",
        execute(context) {
            const { args, priorOutputs } = context;
            let items: unknown[] | undefined;
            if (Array.isArray(args["items"])) {
                items = args["items"] as unknown[];
            } else if (typeof args["from"] === "string") {
                // 4C tool → action propagation: `from` names the producing
                // step; the DATA flows through priorOutputs, never through
                // auto-injected args.
                const source = priorOutputs[args["from"]];
                items = Array.isArray(source)
                    ? source
                    : source && typeof source === "object"
                        ? ["items", "results", "picked"]
                            .map(key => (source as Record<string, unknown>)[key])
                            .find(value => Array.isArray(value)) as unknown[] | undefined
                        : undefined;
            }
            const count = typeof args["count"] === "number" ? args["count"] : 3;
            return { picked: (items ?? []).slice(0, count) };
        },
    });

    registry.register({
        name: "note.compose",
        description: "Compose a working note from a template + args/priorOutputs (no Neo4j write).",
        execute(context) {
            const { args, priorOutputs } = context;
            const template = String(args["template"] ?? "{goal}");
            // Resolution order preserves the 4C boundary: explicit args win,
            // then priorOutputs by step id, then NESTED fields of any prior
            // step output (e.g. {picked} ← priorOutputs.pick.picked).
            const resolve = (key: string): unknown => {
                if (key in args) return args[key];
                if (key in priorOutputs) return priorOutputs[key];
                for (const value of Object.values(priorOutputs)) {
                    if (value && typeof value === "object" && !Array.isArray(value) && key in (value as object)) {
                        return (value as Record<string, unknown>)[key];
                    }
                }
                return undefined;
            };
            const rendered = template.replace(/\{(\w+)\}/g, (_match: string, key: string) => {
                if (key === "goal") return context.goal;
                const value = resolve(key);
                if (value === undefined) return "";
                if (typeof value === "string") return value;
                if (Array.isArray(value)) {
                    return value.map(item => (typeof item === "string" ? item : JSON.stringify(item))).join(", ");
                }
                return JSON.stringify(value);
            });
            return { note: rendered };
        },
    });

    return registry;
}