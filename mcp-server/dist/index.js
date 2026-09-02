import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
const PORT = Number(process.env.PORT ?? 4100);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase environment variables");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const WORKSPACE = path.resolve(process.env.WORKSPACE_PATH ?? "../workspace");
function safePath(input) {
    const resolved = path.resolve(WORKSPACE, input);
    if (resolved !== WORKSPACE &&
        !resolved.startsWith(WORKSPACE + path.sep)) {
        throw new Error("Path is outside the workspace");
    }
    return resolved;
}
function createServer() {
    const server = new Server({
        name: "workspace-mcp",
        version: "1.0.0",
    }, {
        capabilities: {
            tools: {},
        },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "list_files",
                description: "List files and folders inside the user's workspace.",
                inputSchema: {
                    type: "object",
                    properties: {
                        directory: {
                            type: "string",
                            description: "Directory relative to the workspace. Defaults to the workspace root.",
                        },
                    },
                },
            },
            {
                name: "read_file",
                description: "Read the contents of a file in the workspace.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Path of the file relative to the workspace.",
                        },
                    },
                    required: ["path"],
                },
            },
            {
                name: "create_file",
                description: "Create a new file in the workspace.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Path of the new file.",
                        },
                        content: {
                            type: "string",
                            description: "Contents of the file.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
            {
                name: "update_file",
                description: "Replace the contents of an existing workspace file.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Path of the file.",
                        },
                        content: {
                            type: "string",
                            description: "New contents of the file.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
            {
                name: "delete_file",
                description: "Delete a file from the workspace.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Path of the file to delete.",
                        },
                    },
                    required: ["path"],
                },
            },
            {
                name: "create_folder",
                description: "Create a folder in the workspace.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Path of the folder to create.",
                        },
                    },
                    required: ["path"],
                },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case "list_files": {
                    const directory = typeof args?.directory === "string"
                        ? args.directory
                        : "";
                    const target = safePath(directory);
                    const entries = await fs.readdir(target, {
                        withFileTypes: true,
                    });
                    const files = entries.map((entry) => ({
                        name: entry.name,
                        type: entry.isDirectory()
                            ? "directory"
                            : "file",
                        path: path.relative(WORKSPACE, path.join(target, entry.name)),
                    }));
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(files, null, 2),
                            },
                        ],
                    };
                }
                case "read_file": {
                    const filePath = safePath(String(args?.path ?? ""));
                    const content = await fs.readFile(filePath, "utf8");
                    return {
                        content: [
                            {
                                type: "text",
                                text: content,
                            },
                        ],
                    };
                }
                case "create_file": {
                    const filePath = safePath(String(args?.path ?? ""));
                    const content = String(args?.content ?? "");
                    await fs.mkdir(path.dirname(filePath), {
                        recursive: true,
                    });
                    await fs.writeFile(filePath, content, "utf8");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Created ${path.relative(WORKSPACE, filePath)}`,
                            },
                        ],
                    };
                }
                case "update_file": {
                    const filePath = safePath(String(args?.path ?? ""));
                    const content = String(args?.content ?? "");
                    await fs.writeFile(filePath, content, "utf8");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Updated ${path.relative(WORKSPACE, filePath)}`,
                            },
                        ],
                    };
                }
                case "delete_file": {
                    const filePath = safePath(String(args?.path ?? ""));
                    await fs.unlink(filePath);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Deleted ${path.relative(WORKSPACE, filePath)}`,
                            },
                        ],
                    };
                }
                case "create_folder": {
                    const folderPath = safePath(String(args?.path ?? ""));
                    await fs.mkdir(folderPath, {
                        recursive: true,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Created ${path.relative(WORKSPACE, folderPath)}`,
                            },
                        ],
                    };
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: error instanceof Error
                            ? error.message
                            : String(error),
                    },
                ],
            };
        }
    });
    return server;
}
const app = express();
app.use(express.json());
const sessions = new Map();
app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
        let transport;
        if (sessionId && sessions.has(sessionId)) {
            transport = sessions.get(sessionId);
        }
        else {
            transport =
                new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        sessions.set(id, transport);
                    },
                });
            transport.onclose = () => {
                const id = transport.sessionId;
                if (id) {
                    sessions.delete(id);
                }
            };
            const server = createServer();
            await server.connect(transport);
        }
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        console.error(error);
        if (!res.headersSent) {
            res.status(500).json({
                error: "MCP request failed",
            });
        }
    }
});
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
            error: "Missing or invalid MCP session",
        });
        return;
    }
    await sessions
        .get(sessionId)
        .handleRequest(req, res);
});
app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
            error: "Missing or invalid MCP session",
        });
        return;
    }
    await sessions
        .get(sessionId)
        .handleRequest(req, res);
});
app.get("/", (_req, res) => {
    res.json({
        name: "workspace-mcp",
        status: "online",
        endpoint: "/mcp",
    });
});
app.get("/supabase-test", async (_req, res) => {
    const { data, error } = await supabase
        .from("spaces")
        .select("id, name, slug")
        .limit(5);
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json(data);
});
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
app.get("/supabase-admin-test", async (_req, res) => {
    const { data, error } = await supabaseAdmin
        .from("spaces")
        .select("id, user_id, name, slug");
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json(data);
});
async function main() {
    await fs.mkdir(WORKSPACE, {
        recursive: true,
    });
    app.listen(PORT, () => {
        console.error(`Workspace MCP server running on http://localhost:${PORT}`);
        console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
        console.error(`Workspace: ${WORKSPACE}`);
    });
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
