/**
 * Phase 3 — MCP tool adapter (3.7).
 *
 * Makes an MCP tool look EXACTLY like a local ToolRegistry tool: from the
 * executor's perspective `gmail.search` (MCP) and `memory.note` (local) are
 * simply tools. There is deliberately no `if (tool === "gmail.search")`
 * anywhere above the registry — the registry is the abstraction (3.6).
 */
import type { IToolDefinition } from "../toolRegistry.js";
import type { IMcpCallResult, IMcpClient, IMcpToolDefinition } from "./mcpTypes.js";

/**
 * Flatten an MCP `tools/call` result into a plain value:
 * - `isError: true`  → throw (PlanExecutor marks the step failed)
 * - single text block → JSON.parse when possible, else the raw text
 * - multiple text blocks → newline-joined
 * - otherwise the raw result object
 */
export function unwrapMcpResult(result: IMcpCallResult): unknown {
    const texts = (result.content ?? [])
        .filter(block => block.type === "text" && typeof block.text === "string")
        .map(block => block.text as string);

    if (result.isError) {
        throw new Error(texts.length ? texts.join("\n") : "MCP tool call failed");
    }
    if (texts.length === 0) return result;
    if (texts.length === 1) {
        const single = texts[0];
        if (single === undefined) return result;
        try {
            return JSON.parse(single);
        } catch {
            return single;
        }
    }
    return texts.join("\n");
}

export class McpToolAdapter implements IToolDefinition {
    public readonly name: string;
    public readonly description: string;
    public readonly requiredArgs: string[];
    public readonly source = "mcp" as const;
    public readonly server?: string;
    private readonly client: IMcpClient;

    constructor(client: IMcpClient, definition: IMcpToolDefinition, server?: string) {
        this.client = client;
        this.name = definition.name;
        this.description = definition.description ?? `MCP tool ${definition.name}`;
        const required = definition.inputSchema?.required;
        this.requiredArgs = Array.isArray(required)
            ? required.filter((arg): arg is string => typeof arg === "string")
            : [];
        if (server !== undefined) this.server = server;
    }

    /** The registry entry point — indistinguishable from a local tool. */
    public async executor(args: Record<string, unknown>): Promise<unknown> {
        return unwrapMcpResult(await this.client.callTool(this.name, args));
    }
}