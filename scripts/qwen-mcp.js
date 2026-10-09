#!/usr/bin/env node
// Manage which MCP servers Qwen Desktop can use.
//   node scripts/qwen-mcp.js discover          scan this PC for MCP servers and register them
//   node scripts/qwen-mcp.js list              show the registry (name, risk, enabled)
//   node scripts/qwen-mcp.js enable <name...>  turn servers on   (or: enable --all)
//   node scripts/qwen-mcp.js disable <name...> turn servers off  (or: disable --all)
// Changes apply to a running Qwen within a few seconds; nothing is copied out of the source configs.
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../src/main/registry.js");

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
const regFile = path.join(home, ".qwen-mcp", "servers.json");

const readText = (f) => fs.readFileSync(f, "utf8").replace(/^﻿/, "");
const readJson = (f) => JSON.parse(readText(f));

function listPluginMcp() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === ".mcp.json" || e.name === "plugin.json") out.push(p);
    }
  };
  const isPluginFile = (p, name) => name === ".mcp.json" || (name === "plugin.json" && p.includes(`${path.sep}.claude-plugin${path.sep}`));
  walk(path.join(home, ".claude", "plugins", "cache"), 0); // installed plugins only, not the marketplace catalog
  // Claude Desktop extensions ship their own .mcp.json
  const ext = path.join(appData, "Claude", "Claude Extensions");
  try {
    for (const d of fs.readdirSync(ext)) {
      const p = path.join(ext, d, ".mcp.json");
      if (fs.existsSync(p)) out.push(p);
    }
  } catch (_) {}
  return out.filter((p) => isPluginFile(p, path.basename(p)) || p.startsWith(ext));
}

function loadRegistry() {
  try { return readJson(regFile); } catch (_) { return { version: 1, servers: {} }; }
}
function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
}

function discover() {
  const files = R.candidateFiles({ home, appData, exists: fs.existsSync, listPluginMcp });
  const sources = [];
  for (const file of files) {
    try {
      if (!readText(file).trim()) continue; // empty config
      sources.push({ file, json: readJson(file) });
    } catch (e) {
      console.log(`  skipped ${file}: ${e.message}`);
    }
  }
  const reg = R.syncRegistry(loadRegistry(), R.discoverServers(sources));
  saveRegistry(reg);
  console.log(`Scanned ${sources.length} config files.`);
  return reg;
}

function show(reg) {
  const rows = Object.entries(reg.servers).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return console.log("No servers registered. Run: discover");
  const w = Math.max(...rows.map(([n]) => n.length), 4);
  console.log(`${"NAME".padEnd(w)}  STATE     RISK    WHY`);
  for (const [name, e] of rows) {
    const state = e.missing ? "missing" : !e.supported ? "n/a" : e.enabled ? "ENABLED" : "off";
    const why = (e.reasons || []).join("; ") || (e.supported ? "" : "unsupported transport");
    console.log(`${name.padEnd(w)}  ${state.padEnd(8)}  ${e.risk.padEnd(6)}  ${why}`);
  }
  const on = rows.filter(([, e]) => e.enabled && !e.missing && e.supported).length;
  console.log(`\n${on} enabled. Each extra tool adds roughly ${R.TOKENS_PER_TOOL} tokens to every request, so enable what you use.`);
}

function setEnabled(names, value) {
  const reg = loadRegistry();
  const targets = names.includes("--all") ? Object.keys(reg.servers) : names;
  for (const n of targets) {
    const key = Object.keys(reg.servers).find((k) => k.toLowerCase() === n.toLowerCase());
    if (!key) { console.log(`Unknown server: ${n}`); continue; }
    if (value && !reg.servers[key].supported) { console.log(`${key}: unsupported transport, cannot enable`); continue; }
    reg.servers[key].enabled = value;
    console.log(`${key}: ${value ? "enabled" : "disabled"}${value && reg.servers[key].risk === "high" ? "  (HIGH risk: " + reg.servers[key].reasons.join("; ") + ")" : ""}`);
  }
  saveRegistry(reg);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "discover": show(discover()); break;
  case "list": show(loadRegistry()); break;
  case "enable": setEnabled(rest, true); break;
  case "disable": setEnabled(rest, false); break;
  default:
    console.log("usage: qwen-mcp.js discover | list | enable <name...|--all> | disable <name...|--all>");
    process.exit(cmd ? 1 : 0);
}
