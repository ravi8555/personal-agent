/**
 * Phase 3.5/3.6 — MCP server lifecycle manager.
 *
 * When the agent grows from one test server to many (Gmail, Calendar, Web,
 * GitHub, Slack, …) the application needs ONE owner for all server
 * processes:
 *
 *   MCP configuration
 *          ↓
 *   McpServerManager
 *     ├── gmail     → StdioMcpClient
 *     ├── calendar  → StdioMcpClient
 *     ├── github    → StdioMcpClient
 *     └── web       → StdioMcpClient
 *          ↓ (discover + register)
 *   ToolRegistry
 *
 * This is pure infrastructure — it never touches the Agent, Planner or
 * Executor. Those keep talking to the ToolRegistry exactly as before.
 */
import type { ToolRegistry } from "../toolRegistry.js";
import { StdioMcpClient } from "./mcpClient.js";
import type { IMcpClient } from "./mcpTypes.js";
import { McpToolAdapter } from "./mcpToolAdapter.js";
import { registerMcpTools } from "./mcpToolDiscovery.js";

/** Declarative config for one MCP server (Phase 3.6). */
export interface IMcpServerConfig {
    /** Stable id — becomes the tool `server` provenance in the registry. */
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Disabled servers are skipped by registerAll (default true). */
    enabled?: boolean;
    /** Per-request timeout in ms for this server's stdio client. */
    timeoutMs?: number;
}

/** A connected + registered server. */
export interface IMcpServerHandle {
    id: string;
    config: IMcpServerConfig;
    client: IMcpClient;
    tools: McpToolAdapter[];
}

/** Per-server outcome of a bulk operation — one bad server never kills the rest. */
export interface IMcpServerOutcome {
    id: string;
    ok: boolean;
    tools: string[];
    error?: string;
}

export class McpServerManager {
    private readonly servers = new Map<string, { config: IMcpServerConfig; client: StdioMcpClient }>();

    constructor(private readonly registry: ToolRegistry) {}

    /**
     * Connect one server (spawn + initialize), discover its tools and
     * register them into the registry. Disabled configs are skipped.
     * Reconnecting an already-known id closes the old client first.
     */
    public async addServer(config: IMcpServerConfig): Promise<IMcpServerHandle> {
        if (config.enabled === false) {
            throw new Error(`MCP server ${JSON.stringify(config.id)} is disabled`);
        }
        const existing = this.servers.get(config.id);
        if (existing) await existing.client.close().catch(() => undefined);

        const client = new StdioMcpClient({
            command: config.command,
            ...(config.args !== undefined ? { args: config.args } : {}),
            ...(config.env !== undefined ? { env: config.env } : {}),
            ...(config.timeoutMs !== undefined ? { requestTimeoutMs: config.timeoutMs } : {}),
        });
        try {
            await client.connect();
            const tools = await registerMcpTools(this.registry, client, config.id);
            this.servers.set(config.id, { config, client });
            return { id: config.id, config, client, tools };
        } catch (error) {
            // Never leak a half-connected child: close best-effort, then report.
            await client.close().catch(() => undefined);
            throw error;
        }
    }

    /**
     * Connect a fleet of servers. Each server is handled independently:
     * returns per-server outcomes so one broken server never takes down
     * Gmail/Calendar/the Agent along with it.
     */
    public async registerAll(configs: readonly IMcpServerConfig[]): Promise<IMcpServerOutcome[]> {
        const outcomes: IMcpServerOutcome[] = [];
        for (const config of configs) {
            if (config.enabled === false) {
                outcomes.push({ id: config.id, ok: true, tools: [] });
                continue;
            }
            try {
                const handle = await this.addServer(config);
                outcomes.push({ id: config.id, ok: true, tools: handle.tools.map(t => t.name) });
            } catch (error) {
                // One broken server must never take down the fleet: record the
                // failure against this id only and continue with the rest.
                outcomes.push({
                    id: config.id,
                    ok: false,
                    tools: [],
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return outcomes;
    }

    /** Force a single server (re)connection: close, spawn, re-discover, re-register. */
    public async reconnect(id: string): Promise<IMcpServerHandle> {
        const entry = this.servers.get(id);
        if (!entry) throw new Error(`MCP server ${JSON.stringify(id)} is not managed`);
        return this.addServer(entry.config);
    }

    public ids(): string[] {
        return [...this.servers.keys()];
    }

    /**
     * True when the server connected and registered. Full liveness probes
     * (ping/health-check loop) arrive with the Phase 4 approval infrastructure.
     */
    public isHealthy(id: string): boolean {
        return this.servers.has(id);
    }

    public getClient(id: string): IMcpClient | undefined {
        return this.servers.get(id)?.client;
    }

    /** Shut down every managed server process. Call on app exit. */
    public async closeAll(): Promise<void> {
        const entries = [...this.servers.values()];
        this.servers.clear();
        await Promise.all(entries.map(entry => entry.client.close().catch(() => undefined)));
    }
}