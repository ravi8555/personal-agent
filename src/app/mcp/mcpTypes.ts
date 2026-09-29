/**
 * Phase 3 — MCP (Model Context Protocol) types.
 *
 * MCP is an infrastructure/capability layer UNDERNEATH the existing
 * ToolRegistry — not a replacement for the Planner or the Agent.
 *
 * Everything MCP-specific stays inside `src/app/mcp/`, so the Planner,
 * PlanValidator and PlanExecutor never need to know whether a tool is
 * local or served by an MCP server.
 *
 * `IMcpClient` is transport-independent. The current Phase 3 implementation
 * provides:
 *
 *   - InProcessMcpClient — deterministic tests/demos
 *   - StdioMcpClient     — JSON-RPC over stdio
 */

/** JSON-schema-light input descriptor advertised via `tools/list`. */
export interface IMcpInputSchema {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
}

/** A tool advertised by an MCP server (3.3 discovery). */
export interface IMcpToolDefinition {
    name: string;
    description?: string;
    inputSchema?: IMcpInputSchema;
}

/** One content block of a `tools/call` result. */
export interface IMcpContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
}

/** Result of `tools/call`. */
export interface IMcpCallResult {
    content: IMcpContentBlock[];
    isError?: boolean;
}

/**
 * The ONLY MCP surface the rest of the app may see. `McpToolAdapter`
 * flattens this into a normal ToolRegistry tool, which is exactly the
 * Phase 3 boundary: MCP provides capabilities, the Planner decides when
 * those capabilities are needed.
 */
export interface IMcpClient {
    /** `tools/list` — discovery. */
    listTools(): Promise<IMcpToolDefinition[]>;
    /** `tools/call` — execution. */
    callTool(name: string, args: Record<string, unknown>): Promise<IMcpCallResult>;
    /** Release the transport (kill a spawned server, close a socket). */
    close?(): Promise<void> | void;
}