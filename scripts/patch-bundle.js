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
const extras = require("./extras.js");
// Built-in servers (Filesystem, Terminal, Memory, Skills) and registry servers come from extras.js and
// always win over user-added ones. Only the user-added servers are persisted. The page never sees env.
let userMcpConfig = {};
let pageMcpConfig = {};
const applyMcpConfig = async (incoming) => {
  const merged = extras.mergeConfigs({ ...userMcpConfig, ...(incoming || {}) }, extras.managedServers());
  userMcpConfig = merged.persisted;
  pageMcpConfig = merged.page;
  await mcpServer.setMCPServers(adaptConfig(JSON.parse(JSON.stringify(merged.process))));
  settings.set("mcp_config", userMcpConfig);
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
const mcpClientGetConfig = async () => pageMcpConfig;
const mcpClientToolCall = async (_, params) => mcpServer.callTool(params);
const mcpClientUpdateConfig = async (_, config) => {
  await applyMcpConfig(config);
  return mcpClientGetConfig();
};`],
  // Multiple accounts: show the profile name in the window title (see src/main/profile.js).
  [`electron.app.on("will-quit", () => mcpServer.closeAll());`, `electron.app.on("will-quit", () => mcpServer.closeAll());
const { profileName, windowTitle } = require("./profile.js");
const qwenProfile = profileName(process.argv, electron.app.getPath("userData"));
extras.setup({ electron, app: electron.app, apply: applyMcpConfig, profile: qwenProfile });
if (qwenProfile) {
  electron.app.on("browser-window-created", (_, win) => {
    win.setTitle(windowTitle(win.getTitle() || "Qwen", qwenProfile));
    win.on("page-title-updated", (e, title) => {
      e.preventDefault();
      win.setTitle(windowTitle(title || "Qwen", qwenProfile));
    });
  });
}`],
]);
fs.copyFileSync(path.join(repo, 'src/main/mcp-manager.js'), path.join(dir, 'out/main/mcp-manager.js'));
for (const f of ['profile', 'extras', 'registry', 'hooks']) {
  fs.copyFileSync(path.join(repo, `src/main/${f}.js`), path.join(dir, `out/main/${f}.js`));
}
fs.mkdirSync(path.join(dir, 'out/shared'), { recursive: true });
fs.copyFileSync(path.join(repo, 'src/shared/context-guard.js'), path.join(dir, 'out/shared/context-guard.js'));

// ---- preload -------------------------------------------------------------------------------
const preload = path.join(dir, 'out/preload/index.js');
const marker = '// Local MCP always on';
if (fs.readFileSync(preload, 'utf8').includes(marker)) throw new Error('preload already patched; start from the stock bundle');
fs.appendFileSync(preload, `
${marker}: small bridge for the chat page (managed server names, hook events)
{
  const qwenExtras = {
    managed: () => electron.ipcRenderer.invoke("qwen_extras_managed"),
    hook: (e) => electron.ipcRenderer.send("qwen_hook", e)
  };
  try {
    if (process.contextIsolated) electron.contextBridge.exposeInMainWorld("qwenExtras", qwenExtras);
    else window.qwenExtras = qwenExtras;
  } catch (e) { console.error(e); }
}
// (see mcp-always-on.js) Only for the Qwen chat web app, never the shell page.
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
