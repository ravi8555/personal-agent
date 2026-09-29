/**
 * Phase 3 — permission policy (3.9): the security boundary between the
 * PlanValidator and the PlanExecutor.
 *
 *     LLM → Planner → PlanValidator → Permission Policy → PlanExecutor →
 *     ToolRegistry → MCP
 *
 * The LLM proposes a plan; it NEVER calls MCP directly (3.10). This policy
 * decides whether an already-validated tool step may actually run:
 *
 *   allow     — read-only / local tools (gmail.search, calendar.list_events,
 *               web.search, test.echo, …)
 *   confirm   — external state changes (gmail.send, calendar.delete_event, …).
 *               Phase 3 has no approval UX, so "confirm" BLOCKS execution
 *               with an explicit reason; the approval flow arrives in Phase 4.
 *   deny      — hard-denied tool names.
 */

export type ToolPolicyDecision = "allow" | "confirm" | "deny";

export interface IToolPolicyVerdict {
    decision: ToolPolicyDecision;
    reason: string;
}

export interface IToolPolicy {
    canExecute(
        tool: string,
        args: Record<string, unknown>,
    ): Promise<IToolPolicyVerdict> | IToolPolicyVerdict;
}

/** Tool-name tokens that require user confirmation before running. */
export const CONFIRM_TOOL_TOKENS = [
    "send",
    "delete",
    "remove",
    "cancel",
    "destroy",
    "drop",
    "purge",
    "move",
    "rename",
    "revoke",
    "publish",
] as const;

/** Tool-name tokens that are never allowed (deny > confirm > allow). */
export const DENY_TOOL_TOKENS = ["drop_database", "wipe", "shutdown_host"] as const;

function toolTokens(name: string): string[] {
    return name.toLowerCase().split(/[._\-/]/g).filter(Boolean);
}

/** Default policy: read-only allow, state-changing confirm, deny-list first. */
export function createDefaultToolPolicy(): IToolPolicy {
    return {
        canExecute(tool: string): IToolPolicyVerdict {
            const tokens = toolTokens(tool);
            if (tokens.some(token => (DENY_TOOL_TOKENS as readonly string[]).includes(token))) {
                return { decision: "deny", reason: `${tool} is on the tool-policy deny list` };
            }
            if (tokens.some(token => (CONFIRM_TOOL_TOKENS as readonly string[]).includes(token))) {
                return {
                    decision: "confirm",
                    reason: `${tool} changes external state and requires user confirmation — blocked in Phase 3 (approval flow arrives in Phase 4)`,
                };
            }
            return { decision: "allow", reason: "read-only or local tool" };
        },
    };
}

/** Escape hatch for tests / trusted deployments. */
export const allowAllToolPolicy: IToolPolicy = {
    canExecute(): IToolPolicyVerdict {
        return { decision: "allow", reason: "allow-all policy" };
    },
};