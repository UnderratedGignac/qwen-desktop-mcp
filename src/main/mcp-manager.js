"use strict";
// Drop-in replacement for @ali/spark-mcp's Proxy (same method names), fixing:
//  - one persistent client per server, shared by concurrent callers (no duplicate spawns)
//  - re-setting an unchanged config keeps live servers (no restart per chat message)
//  - changed/removed servers are closed (no leaked child processes)
//  - tools/list cached per connection
//  - dead servers reconnect automatically and the failed call is retried once
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const CONNECT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 30 * 60000;

const withTimeout = (promise, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

const fingerprint = (c) =>
  JSON.stringify([c.transportType || "stdio", c.command, c.args || [], c.url || null, c.cwd || null]);

class McpManager {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.configs = {};
    this.entries = {}; // name -> { fp, client, connecting, tools }
  }

  async setMCPServers(servers) {
    const next = { ...(servers || {}) };
    for (const name of Object.keys(this.entries)) {
      if (!next[name] || fingerprint(next[name]) !== this.entries[name].fp) this._drop(name);
    }
    for (const name of Object.keys(next)) {
      if (!this.entries[name]) this.entries[name] = { fp: fingerprint(next[name]), client: null, connecting: null, tools: null };
    }
    this.configs = next;
  }

  getMCPServers() {
    return this.configs;
  }

  async listTools({ serverName }) {
    const entry = this._entry(serverName);
    if (entry.tools) return { tools: entry.tools };
    const client = await this._client(serverName);
    const res = await client.listTools();
    if (this.entries[serverName] === entry) entry.tools = res.tools;
    return res;
  }

  async callTool({ serverName, toolName, toolArguments }) {
    const call = async () => {
      const client = await this._client(serverName);
      return client.callTool({ name: toolName, arguments: toolArguments }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      });
    };
    try {
      return await call();
    } catch (e) {
      const entry = this.entries[serverName];
      // Only retry when the connection itself is gone; tool errors are returned as-is.
      if (entry && !entry.client) {
        this.log(`[mcp] ${serverName} connection lost, reconnecting and retrying ${toolName}`);
        return call();
      }
      throw e;
    }
  }

  async prewarm() {
    await Promise.all(
      Object.keys(this.configs).map((name) =>
        this.listTools({ serverName: name }).then(
          (r) => this.log(`[mcp] ${name} ready (${(r.tools || []).length} tools)`),
          (e) => this.log(`[mcp] ${name} failed to start: ${e && e.message}`)
        )
      )
    );
  }

  closeAll() {
    for (const name of Object.keys(this.entries)) this._drop(name);
  }

  _entry(name) {
    const entry = this.entries[name];
    if (!entry || !this.configs[name]) throw new Error(`Server configuration not found: ${name}`);
    return entry;
  }

  _client(name) {
    const entry = this._entry(name);
    if (entry.client) return Promise.resolve(entry.client);
    if (!entry.connecting) {
      entry.connecting = this._connect(name, entry).finally(() => { entry.connecting = null; });
    }
    return entry.connecting;
  }

  async _connect(name, entry) {
    const config = this.configs[name];
    const client = new Client({ name: "qwen-desktop", version: "1.0.0" }, { capabilities: {} });
    let transport;
    if (config.transportType === "httpStream") transport = new StreamableHTTPClientTransport(new URL(config.url));
    else if (config.transportType === "sse") transport = new SSEClientTransport(new URL(config.url));
    else transport = new StdioClientTransport({ ...config, stderr: "ignore" });
    client.onclose = () => {
      if (entry.client === client) {
        entry.client = null;
        entry.tools = null;
      }
    };
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connecting to MCP server ${name}`);
    } catch (e) {
      client.close().catch(() => {});
      throw e;
    }
    if (this.entries[name] !== entry) {
      // Config changed while we were connecting; this client is stale.
      client.close().catch(() => {});
      return this._client(name);
    }
    entry.client = client;
    return client;
  }

  _drop(name) {
    const entry = this.entries[name];
    delete this.entries[name];
    if (entry && entry.client) entry.client.close().catch(() => {});
    if (entry && entry.connecting) entry.connecting.then((c) => c && c.close().catch(() => {}), () => {});
  }
}

module.exports = { McpManager };
