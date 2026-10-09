"use strict";
// Main-process glue for the extras: built-in servers, the device registry, hooks, and the IPC the chat
// page uses. Kept out of the patched Qwen file so it can be tested and changed in one place.
const fs = require("fs");
const os = require("os");
const path = require("path");
const registry = require("./registry.js");
const hooks = require("./hooks.js");

const dirOf = (home) => path.join(home, ".qwen-mcp");
const BUILTIN_SCRIPTS = (home) => ({
  Filesystem: { script: "mcp_filesystem_server.js", args: [home, "C:\\"] },
  Terminal: { script: "mcp_terminal_server.js", args: [] },
  Memory: { script: "mcp_memory_server.js", args: [] },
  Skills: { script: "mcp_skills_server.js", args: [] },
});

const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

// Built-in servers plus every enabled registry server. Registry servers keep their env (API keys)
// for the server process only; see forPage().
function managedServers({ home = os.homedir(), readJson = readJsonFile } = {}) {
  const dir = dirOf(home);
  const out = {};
  let reg = { servers: {} };
  try { reg = readJson(path.join(dir, "servers.json")); } catch (_) {}
  Object.assign(out, registry.resolveEnabled(reg, readJson));
  for (const [name, b] of Object.entries(BUILTIN_SCRIPTS(home))) {
    out[name] = { name, command: "node", args: [path.join(dir, b.script), ...b.args], transportType: "stdio" };
  }
  return out;
}

// What the web page may see: the same servers without environment variables.
function forPage(cfg) {
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => {
    const { env, ...rest } = v || {};
    return [k, rest];
  }));
}

// user: servers the app/page added itself. managed: built-in + registry (these always win on name clashes).
function mergeConfigs(user, managed) {
  const clash = new Set(Object.keys(managed).map((k) => k.toLowerCase()));
  const mine = Object.fromEntries(Object.entries(user || {}).filter(([k]) => !clash.has(k.toLowerCase())));
  return {
    process: { ...mine, ...managed },
    page: forPage({ ...mine, ...managed }),
    persisted: forPage(mine),
  };
}

function setup({ electron, app, apply, profile }) {
  const { ipcMain, BrowserWindow, Notification } = electron;
  const home = os.homedir();
  const dir = dirOf(home);
  const hooksFile = path.join(dir, "hooks.json");

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(hooksFile)) fs.writeFileSync(hooksFile, JSON.stringify(hooks.defaultConfig(), null, 2));
  } catch (_) {}

  ipcMain.handle("qwen_extras_managed", () => Object.keys(managedServers()));

  const deps = {
    profile,
    isFocused: () => !!BrowserWindow.getFocusedWindow(),
    notify: ({ title, body }) => {
      try { new Notification({ title, body }).show(); } catch (_) {}
      for (const w of BrowserWindow.getAllWindows()) { try { w.flashFrame(true); } catch (_) {} }
    },
    spawn: (command, env, stdin) => {
      const child = require("child_process").spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] }
      );
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
      setTimeout(() => { try { child.kill(); } catch (_) {} }, 30000).unref();
    },
  };

  let recent = [];
  ipcMain.on("qwen_hook", (_, raw) => {
    const now = Date.now();
    recent = recent.filter((t) => now - t < 10000);
    if (recent.length >= 20) return; // a misbehaving page cannot flood the user with hooks
    recent.push(now);
    const ev = hooks.sanitizeEvent({ ...(raw && typeof raw === "object" ? raw : {}), type: "qwen-hook" });
    if (!ev) return;
    let text = "";
    try { text = fs.readFileSync(hooksFile, "utf8"); } catch (_) {}
    hooks.runHooks(ev, hooks.parseConfig(text), deps).catch(() => {});
  });

  // Registry changes (qwen-mcp enable/disable) apply to the running app within a moment.
  let timer = null;
  try {
    fs.watch(dir, (_, name) => {
      if (name !== "servers.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => apply({}).catch(() => {}), 500);
    });
  } catch (_) {}
}

module.exports = { managedServers, forPage, mergeConfigs, setup };
