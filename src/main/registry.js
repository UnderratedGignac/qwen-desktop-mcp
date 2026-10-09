"use strict";
// Registry of MCP servers found on the device. Each entry POINTS at the server's definition in its
// original config file ({from: {file, path}}) and is resolved fresh at runtime, so API keys and tokens
// stay where they already live and are never copied into this registry or shown by the CLI.
const path = require("path");

const BUILTIN = ["filesystem", "terminal", "memory", "skills"];
const TOKENS_PER_TOOL = 250; // rough prompt cost of one tool definition, for the doctor's estimate

const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS$|DSN|CREDENTIAL|CONNECTION|AUTH)/i;
const DATABASE = /(oracle|sql|postgres|mysql|mongo|redis|database|(^|[-_])db([-_]|$))/i;
const DESKTOP = /(windows-mcp|desktop|computer-use|pyautogui|autogui)/i;
const ACCOUNTS = /(stripe|github|gitlab|slack|discord|telegram|imessage|gmail|google|notion|linear|asana|jira|atlassian|datadog|pagerduty|figma|firebase|terraform|salesforce|hubspot|zendesk|sentry)/i;
const REAL_BROWSER = /(claude-in-chrome|browsermcp|browser-mcp)/i;
const OWN_BROWSER = /(playwright|puppeteer|chrome-devtools|selenium|browser)/i;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const looksLikeServer = (v) => isObj(v) && (typeof v.command === "string" || typeof v.url === "string");

function redactArgs(args) {
  const out = [];
  (args || []).forEach((a, i) => {
    const prev = String(args[i - 1] || "");
    if (/^--?[\w-]*(key|token|secret|password|auth)[\w-]*$/i.test(prev)) return out.push("***");
    const m = String(a).match(/^(--?[\w-]*(?:key|token|secret|password|auth)[\w-]*)=/i);
    out.push(m ? `${m[1]}=***` : a);
  });
  return out;
}

function classify(name, def) {
  const reasons = [];
  let risk = "low";
  const bump = (level, why) => {
    reasons.push(why);
    if (level === "high" || (level === "medium" && risk === "low")) risk = level;
  };
  const envKeys = Object.keys(def.env || {});
  const argText = (def.args || []).join(" ");
  const hay = `${name} ${def.command || ""} ${argText}`;
  if (envKeys.some((k) => SECRET_KEY.test(k))) bump("high", "has credentials in its environment");
  if (def.headers) bump("high", "remote server with auth headers");
  else if (def.url) bump("high", "remote server (your data goes to a third party)");
  if (/--autoConnect|--browser-url|--remote-debugging/i.test(argText)) bump("high", "attaches to your running Chrome (logged-in sessions)");
  if (REAL_BROWSER.test(hay)) bump("high", "drives your real browser");
  if (DATABASE.test(name)) bump("high", "database access");
  const commandName = String(def.command || "").split(/[\\/]/).pop();
  if (DESKTOP.test(`${name} ${commandName}`)) bump("high", "controls your desktop"); // not paths: they contain "Desktop"
  if (ACCOUNTS.test(name)) bump("high", "account access");
  if (risk === "low" && OWN_BROWSER.test(hay)) bump("medium", "launches its own browser");
  return { risk, reasons };
}

function entryFor(name, def, file, keyPath) {
  const { risk, reasons } = classify(name, def);
  const remote = typeof def.url === "string";
  return {
    name,
    from: { file, path: keyPath },
    transport: remote ? (def.type === "sse" ? "sse" : "http") : "stdio",
    command: def.command || null,
    args: redactArgs(def.args),
    url: remote ? def.url : null,
    envKeys: Object.keys(def.env || {}),
    risk,
    reasons,
    supported: remote ? !def.headers : typeof def.command === "string",
  };
}

function serverMaps(json) {
  const maps = [];
  if (!isObj(json)) return maps;
  if (isObj(json.mcpServers)) maps.push({ map: json.mcpServers, path: ["mcpServers"] });
  if (isObj(json.projects)) {
    for (const p of Object.keys(json.projects)) {
      const m = json.projects[p] && json.projects[p].mcpServers;
      if (isObj(m)) maps.push({ map: m, path: ["projects", p, "mcpServers"] });
    }
  }
  if (!maps.length) {
    const vals = Object.values(json);
    if (vals.length && vals.every(looksLikeServer)) maps.push({ map: json, path: [] }); // bare plugin .mcp.json
  }
  return maps;
}

// sources: [{ file, json }] in priority order. Returns one entry per server name (first source wins).
function discoverServers(sources) {
  const seen = new Set();
  const found = [];
  for (const { file, json } of sources) {
    for (const { map, path: base } of serverMaps(json)) {
      for (const name of Object.keys(map)) {
        const key = name.toLowerCase();
        if (BUILTIN.includes(key) || seen.has(key) || !looksLikeServer(map[name])) continue;
        seen.add(key);
        found.push(entryFor(name, map[name], file, [...base, name]));
      }
    }
  }
  return found;
}

// Merges a fresh scan into the saved registry. Everything starts OFF: risk rules cannot tell what a
// local script does (an "ai-job-applier" server can send applications for you), so turning a server
// on is always the user's decision. Their enabled/disabled choice for known servers is kept.
function syncRegistry(existing, found) {
  const servers = {};
  const prev = (existing && existing.servers) || {};
  const names = new Set();
  for (const f of found) {
    names.add(f.name);
    const old = prev[f.name];
    servers[f.name] = {
      from: f.from,
      transport: f.transport,
      risk: f.risk,
      reasons: f.reasons,
      supported: f.supported,
      envKeys: f.envKeys,
      command: f.command,
      args: f.args,
      url: f.url,
      enabled: old ? !!old.enabled : false,
    };
  }
  for (const name of Object.keys(prev)) {
    if (!names.has(name)) servers[name] = { ...prev[name], missing: true };
  }
  return { version: 1, servers };
}

function expand(value, pluginRoot) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v) => {
    if (v === "CLAUDE_PLUGIN_ROOT" && pluginRoot) return pluginRoot;
    return process.env[v] != null ? process.env[v] : m;
  });
}

function nodeAt(json, keyPath) {
  return keyPath.reduce((n, k) => (n == null ? n : n[k]), json);
}

// Live configs (with env) for every enabled, available server, in the shape Qwen's MCP manager expects.
function resolveEnabled(registry, readJson) {
  const out = {};
  for (const [name, e] of Object.entries((registry && registry.servers) || {})) {
    if (!e.enabled || e.missing || !e.supported) continue;
    let def;
    try {
      def = nodeAt(readJson(e.from.file), e.from.path);
    } catch (_) {
      continue;
    }
    if (!looksLikeServer(def) || def.headers) continue;
    const root = path.win32.dirname(e.from.file);
    if (typeof def.url === "string") {
      out[name] = { name, url: def.url, transportType: def.type === "sse" ? "sse" : "httpStream" };
      continue;
    }
    const cfg = { name, command: def.command, args: (def.args || []).map((a) => expand(a, root)), transportType: "stdio" };
    if (isObj(def.env)) cfg.env = Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, expand(v, root)]));
    if (def.cwd) cfg.cwd = expand(def.cwd, root);
    out[name] = cfg;
  }
  return out;
}

// Config files that can hold MCP servers on this machine, most authoritative first.
function candidateFiles({ home, appData, exists, listPluginMcp }) {
  const list = [
    `${home}\\.claude.json`,
    `${home}\\.claude\\settings.json`,
    `${appData}\\Claude\\claude_desktop_config.json`,
    `${home}\\.gemini\\settings.json`,
    `${home}\\.gemini\\config\\mcp_config.json`,
    `${home}\\.antigravitycli\\settings.json`,
    `${home}\\.antigravitycli\\config\\mcp_config.json`,
    `${home}\\.antigravitycli\\antigravity\\mcp_config.json`,
    `${home}\\.qwen\\settings.json`,
    `${appData}\\Code\\User\\mcp.json`,
    `${home}\\.cursor\\mcp.json`,
    ...listPluginMcp(),
  ];
  return list.filter((f) => exists(f));
}

module.exports = { BUILTIN, TOKENS_PER_TOOL, classify, discoverServers, syncRegistry, resolveEnabled, candidateFiles, redactArgs };
