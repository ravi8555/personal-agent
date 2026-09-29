/**
 * Phase 3 — MCP clients.
 *
 * - InProcessMcpClient — an MCP server simulated inside the process
 *   (tests / demos: no spawn, no network, deterministic).
 * - StdioMcpClient     — a real MCP stdio client: spawns a server process
 *   and speaks newline-delimited JSON-RPC 2.0 (initialize handshake,
 *   tools/list, tools/call).
 *
 * Both implement IMcpClient, so McpToolAdapter / ToolRegistry cannot tell
 * them apart — that indirection is the whole point of 3.6.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { IMcpCallResult, IMcpClient, IMcpToolDefinition } from "./mcpTypes.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Wrap a handler payload as an MCP text content result. */
function textResult(payload: unknown): IMcpCallResult {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// In-process MCP server (tests / demos)
// ---------------------------------------------------------------------------

export interface IInProcessMcpTool {
    definition: IMcpToolDefinition;
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export class InProcessMcpClient implements IMcpClient {
    private readonly definitions = new Map<string, IMcpToolDefinition>();
    private readonly handlers = new Map<string, IInProcessMcpTool["handler"]>();

    constructor(tools: readonly IInProcessMcpTool[] = []) {
        for (const tool of tools) this.addTool(tool);
    }

    public addTool(tool: IInProcessMcpTool): void {
        this.definitions.set(tool.definition.name, tool.definition);
        this.handlers.set(tool.definition.name, tool.handler);
    }

    public async listTools(): Promise<IMcpToolDefinition[]> {
        return [...this.definitions.values()];
    }

    public async callTool(name: string, args: Record<string, unknown>): Promise<IMcpCallResult> {
        const handler = this.handlers.get(name);
        if (!handler) {
            return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
        }
        try {
            return textResult(await handler(args));
        } catch (error) {
            return {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Stdio MCP server (real JSON-RPC child process)
// ---------------------------------------------------------------------------

export interface IStdioMcpClientOptions {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Per-request timeout (default 10s). */
    requestTimeoutMs?: number;
}

interface IPendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class StdioMcpClient implements IMcpClient {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, IPendingRequest>();
    private readonly requestTimeoutMs: number;
    private stderrBuffer = "";

    constructor(private readonly options: IStdioMcpClientOptions) {
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    }

    /** Spawn the server process and complete the MCP initialize handshake. */
    public async connect(): Promise<void> {
        if (this.proc) return;

        const proc = spawn(this.options.command, this.options.args ?? [], {
            env: { ...process.env, ...(this.options.env ?? {}) },
        });
        this.proc = proc;

        createInterface({ input: proc.stdout }).on("line", (line: string) => this.handleLine(line));
        proc.stderr.on("data", (chunk: Buffer | string) => {
            this.stderrBuffer += String(chunk);
        });
        proc.on("exit", (code: number | null) => {
            this.proc = null;
            this.rejectAll(new Error(`MCP server exited (code ${code ?? "?"})${this.stderrTail()}`));
        });
        proc.on("error", (error: Error) => {
            this.rejectAll(new Error(`MCP server error: ${error.message}${this.stderrTail()}`));
        });

        await this.request(
            "initialize",
            {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "personal-agent", version: "1.0.0" },
            },
            this.requestTimeoutMs,
        );
        // Notification (no id) — must not be answered by the server.
        this.notify("notifications/initialized", {});
    }

    public async listTools(): Promise<IMcpToolDefinition[]> {
        this.ensureConnected();
        const result = (await this.request("tools/list", {}, this.requestTimeoutMs)) as {
            tools?: IMcpToolDefinition[];
        };
        return Array.isArray(result?.tools) ? result.tools : [];
    }

    public async callTool(name: string, args: Record<string, unknown>): Promise<IMcpCallResult> {
        this.ensureConnected();
        const result = (await this.request(
            "tools/call",
            { name, arguments: args },
            this.requestTimeoutMs,
        )) as IMcpCallResult;
        return Array.isArray(result?.content) ? result : { content: [] };
    }

    public async close(): Promise<void> {
        const proc = this.proc;
        this.proc = null;
        this.rejectAll(new Error("MCP client closed"));
        if (proc && proc.exitCode === null && !proc.killed) proc.kill();
    }

    // -- internals ----------------------------------------------------------

    private ensureConnected(): void {
        if (!this.proc) throw new Error("StdioMcpClient: not connected — call connect() first");
    }

    private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        this.ensureConnected();
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms${this.stderrTail()}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc?.stdin.write(`${payload}\n`);
        });
    }

    private notify(method: string, params: unknown): void {
        this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }

    private handleLine(line: string): void {
        let message: { id?: unknown; result?: unknown; error?: { message?: string } };
        try {
            message = JSON.parse(line);
        } catch {
            return; // non-JSON noise on stdout — ignore
        }
        if (typeof message.id !== "number") return; // server→client notification
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`MCP error: ${message.error.message ?? "unknown"}`));
        else entry.resolve(message.result);
    }

    private rejectAll(error: Error): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    private stderrTail(): string {
        const tail = this.stderrBuffer.trim().slice(-400);
        return tail ? ` — stderr: ${tail}` : "";
    }
}
