// Applies the MCP patch to an extracted stock Qwen Desktop bundle (app.asar contents).
// Usage: node scripts/patch-bundle.js <extracted-dir>
// Fails loudly if an anchor is missing, i.e. Qwen changed and the patch needs updating.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/patch-bundle.js <extracted-app-dir>');
const repo = path.join(__dirname, '..');

function patchFile(file, edits) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    if (!s.includes(from)) throw new Error(`${path.basename(file)}: anchor not found: ${from.slice(0, 70)}`);
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
}

// ---- main process --------------------------------------------------------------------------
patchFile(path.join(dir, 'out/main/index.js'), [
  // Resolve bare "node" on Windows and don't clobber PATH with a POSIX one.
  [`    config.command = cmd;
`, `    config.command = cmd;
    if (process.platform === "win32" && cmd === "node") config.command = resolveWindowsNode();
`],
  [`    config.env = {
      PATH,
      ...process.env,
      ...config.env
    };`, `    config.env = process.platform === "win32" ? { ...process.env, ...config.env } : {
      PATH,
      ...process.env,
      ...config.env
    };`],
  [`function adaptConfig(configs) {`, `function resolveWindowsNode() {
  const dirs = (process.env.Path || process.env.PATH || "").split(";").filter(Boolean);
  dirs.push("C:\\\\Program Files\\\\nodejs");
  for (const d of dirs) {
    const p = path.join(d, "node.exe");
    if (fs$1.existsSync(p)) return p;
  }
  return "node";
}
function adaptConfig(configs) {`],
  // Replace the spark-mcp proxy with the persistent manager; Filesystem + Terminal always present.
  [`const mcpServer = new sparkMcp.Proxy();`, `const { McpManager } = require("./mcp-manager.js");
const mcpServer = new McpManager();
const QWEN_MCP_DIR = path.join(os.homedir(), ".qwen-mcp");
const MANAGED_MCP_SERVERS = {
  Filesystem: { name: "Filesystem", command: "node", args: [path.join(QWEN_MCP_DIR, "mcp_filesystem_server.js"), os.homedir(), "C:\\\\"], transportType: "stdio" },
  Terminal: { name: "Terminal", command: "node", args: [path.join(QWEN_MCP_DIR, "mcp_terminal_server.js")], transportType: "stdio" }
};
let rawMcpConfig = {};
const applyMcpConfig = async (incoming) => {
  const strip = (cfg) => Object.fromEntries(Object.entries(cfg || {}).map(([k, v]) => {
    const { env, ...rest } = v || {};
    return [k, rest];
  }));
  rawMcpConfig = { ...strip(rawMcpConfig), ...strip(incoming), ...MANAGED_MCP_SERVERS };
  await mcpServer.setMCPServers(adaptConfig(JSON.parse(JSON.stringify(rawMcpConfig))));
  settings.set("mcp_config", rawMcpConfig);
};
(async () => {
  let saved = {};
  try { saved = await settings.get("mcp_config") || {}; } catch (_) {}
  await applyMcpConfig(saved);
  mcpServer.prewarm();
})();
electron.app.on("will-quit", () => mcpServer.closeAll());`],
  [`const mcpClientToolList = async (_, serverName) => {
  try {
    const list = await mcpServer.listTools({ serverName });
    return list;
  } catch (e) {
    console.log("mcpClientToolList err", e);
    throw e;
  }
};
const mcpClientGetConfig = async () => mcpServer.getMCPServers();
const mcpClientToolCall = async (_, params) => mcpServer.callTool(params);
const mcpClientUpdateConfig = async (_, config) => {
  try {
    console.log("config", config);
    mcpServer.setMCPServers(adaptConfig(config));
    settings.set("mcp_config", config);
    return mcpClientGetConfig();
  } catch (err) {
    console.log("err", err);
    throw err;
  }
};`, `const mcpClientToolList = async (_, serverName) => mcpServer.listTools({ serverName });
// Never hand environment variables (API keys etc.) to the web page.
const mcpClientGetConfig = async () => rawMcpConfig;
const mcpClientToolCall = async (_, params) => mcpServer.callTool(params);
const mcpClientUpdateConfig = async (_, config) => {
  await applyMcpConfig(config);
  return mcpClientGetConfig();
};`],
]);
fs.copyFileSync(path.join(repo, 'src/main/mcp-manager.js'), path.join(dir, 'out/main/mcp-manager.js'));
fs.mkdirSync(path.join(dir, 'out/shared'), { recursive: true });
fs.copyFileSync(path.join(repo, 'src/shared/context-guard.js'), path.join(dir, 'out/shared/context-guard.js'));

// ---- preload -------------------------------------------------------------------------------
const preload = path.join(dir, 'out/preload/index.js');
const marker = '// Local MCP always on';
if (fs.readFileSync(preload, 'utf8').includes(marker)) throw new Error('preload already patched; start from the stock bundle');
fs.appendFileSync(preload, `
${marker} (see mcp-always-on.js). Only for the Qwen chat web app, never the shell page.
if (window.location.protocol === "https:" && /(^|\\.)qwen\\.ai$/.test(window.location.hostname)) {
  try {
    const read = (p) => require("fs").readFileSync(path.join(__dirname, p), "utf8");
    const script = read("../shared/context-guard.js") + "\\n;\\n" + read("mcp-always-on.js");
    electron.webFrame.executeJavaScript(script).catch((e) => console.error("[mcp-always-on]", e));
  } catch (e) {
    console.error("[mcp-always-on] failed to load:", e);
  }
}
`);
fs.copyFileSync(path.join(repo, 'src/preload/mcp-always-on.js'), path.join(dir, 'out/preload/mcp-always-on.js'));

console.log('patched', dir);
