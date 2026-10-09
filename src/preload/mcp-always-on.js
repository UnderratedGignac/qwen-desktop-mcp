// Runs in chat.qwen.ai's main world (injected by the preload). Makes local MCP always on:
//  1. Filesystem + Terminal are always present/enabled in LOCAL_MCP_SERVER with live tool lists.
//  2. Every chat completion request carries the local MCP tools, whether or not the UI toggle is on.
//  3. The per-chat "Allow <tool> (local) to run?" prompt is answered "Allow in this chat" automatically.
(() => {
  if (window.__qwenMcpAlwaysOn || !window.electronAPI) return;
  window.__qwenMcpAlwaysOn = true;

  const api = window.electronAPI;
  const KEY = "LOCAL_MCP_SERVER";
  const MANAGED = ["Filesystem", "Terminal"];
  const BUILTIN_DEFAULTS = ["Fetch", "Filesystem", "Sequential-Thinking"];
  const COMPLETIONS = "/api/v2/chat/completions";

  const readServers = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (_) {
      return [];
    }
  };

  const PENDING = "pending";
  const within = (p, ms) =>
    Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(PENDING)), ms))]);

  // Registers every enabled server with the main process (unchanged ones are not restarted),
  // refreshes tool lists, and returns the tool map of servers that are actually reachable now.
  async function syncServers() {
    const enabled = readServers().filter((s) => s.enabled && !MANAGED.includes(s.name));
    const extra = {};
    for (const s of enabled) extra[s.name] = { name: s.name, ...(s.params || {}), transportType: s.type };
    if (Object.keys(extra).length) await api.mcp_client_update_config(extra).catch(() => {});

    const names = [...MANAGED, ...Object.keys(extra)];
    // Slow-starting servers (npx/uvx downloads) keep connecting in the background; they are
    // simply left out of this message instead of delaying it.
    const results = await Promise.allSettled(names.map((n) => within(api.mcp_client_tool_list(n), 1500)));

    const list = readServers(); // re-read: the page may have written in the meantime
    const live = [];
    names.forEach((name, i) => {
      let s = list.find((x) => x.name === name && x.default) || list.find((x) => x.name === name);
      if (!s && !MANAGED.includes(name)) return;
      if (!s) {
        s = {
          id: crypto.randomUUID(),
          name,
          description: `${name} (local, always on)`,
          type: "stdio",
          params: { command: "node", args: [] },
          default: BUILTIN_DEFAULTS.includes(name),
          tools: []
        };
        list.push(s);
      }
      s.enabled = true;
      const r = results[i];
      if (r.status === "fulfilled" && r.value && Array.isArray(r.value.tools)) {
        s.tools = r.value.tools;
        s.connectionStatus = "available";
        s.errorMessage = "";
        live.push(s);
      } else if (r.reason && r.reason.message !== PENDING) {
        s.connectionStatus = "failed";
        s.errorMessage = String(r.reason.message || "").replace(/^Error invoking remote method '[^']+': /, "");
      }
    });
    localStorage.setItem(KEY, JSON.stringify(list));
    return toolMap(live);
  }

  // Same shape as the app's own getFormatAvailableServerMap().
  const toolMap = (servers) =>
    servers.reduce((m, s) => {
      m[s.name] = {};
      for (const t of s.tools) if (t) m[s.name][t.name] = { description: t.description, input_schema: t.inputSchema };
      return m;
    }, {});

  const isEmpty = (o) => !o || typeof o !== "object" || !Object.keys(o).length;

  function injectTools(body, map) {
    if (!body || !Array.isArray(body.messages) || isEmpty(map)) return false;
    let changed = false;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && m.role === "user") {
        if (isEmpty(m.feature_config && m.feature_config.local_mcp)) {
          m.feature_config = { ...(m.feature_config || {}), local_mcp: map };
          changed = true;
        }
        break;
      }
    }
    return changed;
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.includes(COMPLETIONS) && init && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.messages) && body.messages.some((m) => m && m.role === "user")) {
          const map = await syncServers().catch(() => ({}));
          if (injectTools(body, map)) init = { ...init, body: JSON.stringify(body) };
        }
        window.__qwenMcpLastRequest = init.body;
      }
    } catch (e) {
      console.warn("[mcp-always-on] request patch skipped:", e);
    }
    return origFetch.call(this, input, init);
  };

  // Auto-answer the permission prompt with "Allow in this chat" and keep it from flashing.
  // The preload runs before the page's real document exists, so attach DOM hooks once it does.
  const PROMPT = "qwen-mcp-permission-panel-prompt";
  let prompts = [];
  const approve = () => {
    for (const panel of Array.from(prompts)) {
      const group = panel.querySelector(`.${PROMPT}-buttons-right-group`);
      const last = group && group.lastElementChild;
      const btn = last && (last.matches("button") ? last : last.querySelector("button") || last);
      if (btn && !btn.dataset.mcpAutoApproved) {
        btn.dataset.mcpAutoApproved = "1";
        btn.click();
      }
    }
  };
  let queued = false;
  const attachDom = () => {
    prompts = document.getElementsByClassName(PROMPT);
    const style = document.createElement("style");
    style.textContent = `.${PROMPT}{display:none!important}`;
    document.head.appendChild(style);
    new MutationObserver(() => {
      if (queued || !prompts.length) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        approve();
      });
    }).observe(document.body, { childList: true, subtree: true });
    approve();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attachDom, { once: true });
  else attachDom();

  syncServers().catch((e) => console.warn("[mcp-always-on] initial sync failed:", e));
})();
