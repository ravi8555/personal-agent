#!/usr/bin/env node
/**
 * Phase 3 — minimal local MCP server for tests/demos (stdio transport).
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout:
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * Tools: test.echo, calendar.list_events, web.search (mock), gmail.send
 * (present so the permission policy can be proven to block it BEFORE the
 * server is ever reached). No output other than JSON-RPC goes to stdout;
 * diagnostics go to stderr.
 */
import readline from "node:readline";

const TOOLS = [
    {
        name: "test.echo",
        description: "Echo back the provided message (connectivity test tool).",
        inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
        },
    },
    {
        name: "calendar.list_events",
        description: "List calendar events for a given date.",
        inputSchema: {
            type: "object",
            properties: { date: { type: "string" } },
            required: ["date"],
        },
    },
    {
        name: "web.search",
        description: "Search the web (mock results from the local MCP server).",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
        },
    },
    {
        name: "gmail.send",
        description: "Send an email (must be blocked by the tool policy).",
        inputSchema: {
            type: "object",
            properties: { to: { type: "string" }, subject: { type: "string" } },
            required: ["to"],
        },
    },
];

function respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", line => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (method === "initialize") {
        respond(id, {
            protocolVersion: (params && params.protocolVersion) || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mcp-echo-server", version: "1.0.0" },
        });
        return;
    }
    if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) {
        return; // notifications are never answered
    }
    if (method === "tools/list") {
        respond(id, { tools: TOOLS });
        return;
    }
    if (method === "tools/call") {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === "test.echo") {
            respond(id, { content: [{ type: "text", text: JSON.stringify({ echoed: String(args.message ?? "") }) }] });
        } else if (name === "calendar.list_events") {
            respond(id, {
                content: [{
                    type: "text",
                    text: JSON.stringify([
                        { title: "Team standup", time: "09:00" },
                        { title: "Design review", time: "15:00" },
                    ]),
                }],
            });
        } else if (name === "web.search") {
            respond(id, {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        query: String(args.query ?? ""),
                        results: [
                            { title: "Result 1", url: "https://example.com/1" },
                            { title: "Result 2", url: "https://example.com/2" },
                        ],
                    }),
                }],
            });
        } else if (name === "gmail.send") {
            respond(id, { content: [{ type: "text", text: JSON.stringify({ sent: true, to: args.to ?? null }) }] });
        } else {
            respondError(id, -32602, `unknown tool: ${name}`);
        }
        return;
    }
    if (!isNotification) respondError(id, -32601, `method not found: ${method}`);
});

rl.on("close", () => process.exit(0));