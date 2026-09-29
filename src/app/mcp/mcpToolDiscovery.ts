/**
 * Phase 3 — MCP tool discovery (3.3): MCP Server → tools/list → client →
 * adapter → ToolRegistry.
 *
 * The registry's `listTools()` then feeds `knownTools` back into the
 * Planner (3.4), closing the loop:
 * MCP servers → tool discovery → ToolRegistry → knownTools → Planner.
 */
import type { ToolRegistry } from "../toolRegistry.js";
import { McpToolAdapter } from "./mcpToolAdapter.js";
import type { IMcpClient } from "./mcpTypes.js";

/** Discover an MCP server's tools without registering them. */
export async function discoverMcpTools(client: IMcpClient, server?: string): Promise<McpToolAdapter[]> {
    const definitions = await client.listTools();
    return definitions
        .filter(definition => typeof definition?.name === "string" && definition.name.trim())
        .map(definition => new McpToolAdapter(client, definition, server));
}

/** Discover an MCP server's tools and register them into the registry. */
export async function registerMcpTools(
    registry: ToolRegistry,
    client: IMcpClient,
    server?: string,
): Promise<McpToolAdapter[]> {
    const adapters = await discoverMcpTools(client, server);
    for (const adapter of adapters) registry.register(adapter);
    return adapters;
}