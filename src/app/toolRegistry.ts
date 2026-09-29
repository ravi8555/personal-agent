/**
 * Phase 2/3 — ToolRegistry: the abstraction over ALL tools (3.6).
 *
 * Local tools and MCP tools register here in identical shape — the planner,
 * validator and executor never branch on where a tool comes from; they only
 * ever call `registry.execute(step.tool, step.args)`. MCP discovery
 * (src/app/mcp/mcpToolDiscovery.ts) registers adapters into this registry,
 * and `listTools()` feeds the planner's knownTools (3.4).
 */

export interface IToolDefinition {
    name: string;
    description: string;
    requiredArgs?: string[];
    /** Where the tool comes from. Local (default) or an MCP server. */
    source?: "local" | "mcp";
    /** MCP server id when source === "mcp". */
    server?: string;
    executor: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Tool descriptor exposed to the planner (3.3/3.4 knownTools source). */
export interface IToolInfo {
    name: string;
    description: string;
    requiredArgs: string[];
    source: "local" | "mcp";
    server?: string;
}

export class ToolRegistry {
    private readonly tools = new Map<string, IToolDefinition>();

    /** Register (or replace) a tool. Names are matched exactly. */
    public register(tool: IToolDefinition): void {
        if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
            throw new Error("ToolRegistry.register: tool must have a non-empty name");
        }
        if (typeof tool.executor !== "function") {
            throw new Error(`ToolRegistry.register: tool ${JSON.stringify(tool.name)} must have an executor`);
        }
        this.tools.set(tool.name, tool);
    }

    public has(name: string): boolean {
        return this.tools.has(name);
    }

    public get(name: string): IToolDefinition | undefined {
        return this.tools.get(name);
    }

    public names(): string[] {
        return [...this.tools.keys()];
    }

    /**
     * Full tool descriptors (3.3) — the discovery feed for the Planner:
     * MCP servers → tool discovery → ToolRegistry → listTools() → knownTools.
     */
    public listTools(): IToolInfo[] {
        return [...this.tools.values()].map(tool => ({
            name: tool.name,
            description: tool.description,
            requiredArgs: tool.requiredArgs ?? [],
            source: tool.source ?? "local",
            ...(tool.server !== undefined ? { server: tool.server } : {}),
        }));
    }

    public requiredArgs(name: string): string[] {
        return this.tools.get(name)?.requiredArgs ?? [];
    }

    /** Required-args map for the plan validator. */
    public requiredArgsMap(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [name, def] of this.tools) out[name] = def.requiredArgs ?? [];
        return out;
    }

    /** Execute a registered tool (throws for unknown tools / failed calls). */
    public async execute(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`ToolRegistry.execute: unknown tool ${JSON.stringify(name)}`);
        return tool.executor(args);
    }
}

/**
 * Default registry used by the Agent: demo-safe local tools only.
 * Real MCP/web tools plug in here in Phase 3 behind the same interface.
 */
export function createDefaultToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();

    registry.register({
        name: "memory.note",
        description: "Record a transient working note during plan execution (no Neo4j write).",
        requiredArgs: ["text"],
        async executor(args) {
            return { noted: String(args["text"] ?? "") };
        },
    });

    registry.register({
        name: "text.summarize",
        description: "Deterministic local summarizer stub (first N chars).",
        requiredArgs: ["text"],
        async executor(args) {
            const text = String(args["text"] ?? "");
            const max = typeof args["maxLength"] === "number" ? args["maxLength"] : 200;
            return { summary: text.slice(0, max) };
        },
    });

    // Phase 2 placeholder for the Phase 3 MCP/web tool. Keeps plans executable
    // end-to-end without network access; replace via `withToolRegistry` when
    // the real MCP search tool lands.
    registry.register({
        name: "web.search",
        description: "Search the web (Phase 2 stub — replaced by the MCP web tool in Phase 3).",
        requiredArgs: ["query"],
        async executor(args) {
            const query = String(args["query"] ?? "");
            return {
                query,
                results: [],
                note: "web.search is a Phase 2 stub: no live results. MCP web tool arrives in Phase 3.",
            };
        },
    });

    return registry;
}
