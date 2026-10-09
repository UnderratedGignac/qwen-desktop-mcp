"use strict";
// Minimal MCP server over stdio (line-delimited JSON-RPC 2.0), zero dependencies.
// call(name, args) returns a string or an array of MCP content items; throw to report a tool error.
const readline = require("readline");

function serve({ name, version = "1.0.0", tools, call }) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch (_) { return; }
    const { id, method, params } = req;
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version } } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools } });
    if (method === "tools/call") {
      const toolName = params && params.name;
      if (!tools.some((t) => t.name === toolName)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
      try {
        const out = await call(toolName, (params && params.arguments) || {});
        const content = Array.isArray(out) ? out : [{ type: "text", text: String(out) }];
        return send({ jsonrpc: "2.0", id, result: { content, isError: false } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
      }
    }
    if (id !== undefined && !String(method).startsWith("notifications/")) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });
  rl.on("close", () => process.exit(0));
  process.on("uncaughtException", (e) => console.error(`[${name}]`, e));
}

module.exports = { serve };
