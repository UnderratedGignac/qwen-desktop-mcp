// Runs in chat.qwen.ai's main world (injected by the preload). Makes local MCP always on:
//  1. Filesystem + Terminal are always present/enabled in LOCAL_MCP_SERVER with live tool lists.
//  2. Every chat completion request carries the local MCP tools, whether or not the UI toggle is on.
//  3. The per-chat "Allow <tool> (local) to run?" prompt is answered "Allow in this chat" automatically.
//  4. Context guard: tool output per turn is budgeted (wrap-up note, then a forced handover), broken
//     or overlong chats get a banner with one-click "Continue in new chat".
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

  // ---- context guard (logic in context-guard.js) -------------------------------------------
  const guard = window.__qwenContextGuard;
  const CHAT_SOFT = 300000; // lifetime tool output after which a fresh chat is suggested
  const STORE = "qwenContextGuard.chats";
  const guardState = guard ? guard.newState() : null;
  window.__qwenContextGuardState = guardState; // for diagnostics from DevTools
  try {
    if (guardState) guardState.chats = JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch (_) {}
  const saveChats = () => {
    try {
      const entries = Object.entries(guardState.chats).slice(-200);
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(entries)));
    } catch (_) {}
  };
  // Optional overrides, e.g. localStorage["qwenContextGuard.limits"] = '{"turnSoft":100000,"turnHard":160000}'
  const userLimits = () => {
    try {
      return JSON.parse(localStorage.getItem("qwenContextGuard.limits") || "{}");
    } catch (_) {
      return {};
    }
  };
  const chatIdFromUrl = () => (location.pathname.match(/\/c\/([0-9a-f-]{36})/) || [])[1] || null;
  // Errors Qwen returns when the conversation no longer fits / lost its first message.
  const CONTEXT_ERROR = /"(?:message|msg|error|code|details)"\s*:\s*"[^"]*(first message must not|context length|maximum context|too many tokens|input is too long|exceed[^"]*(?:token|length|limit))/i;

  function watchStream(res, chatId) {
    if (!res.body || !guard) return;
    const reader = res.clone().body.getReader();
    const dec = new TextDecoder();
    let carry = "";
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const text = carry + dec.decode(value, { stream: true });
        if (CONTEXT_ERROR.test(text)) {
          reader.cancel().catch(() => {});
          return showBanner("broken", chatId);
        }
        carry = text.slice(-300);
      }
    })().catch(() => {});
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    let chatId = null;
    try {
      if (url.includes(COMPLETIONS) && init && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        chatId = body.chat_id || chatIdFromUrl();
        let changed = false;
        if (Array.isArray(body.messages) && body.messages.some((m) => m && m.role === "user")) {
          const map = await syncServers().catch(() => ({}));
          changed = injectTools(body, map);
        }
        if (guard) {
          const g = guard.guardRequest(body, guardState, userLimits());
          changed = changed || g.changed;
          saveChats();
          if (g.level === "stop") showBanner("stop", chatId);
          else if (g.level === "warn") showBanner("warn", chatId, g.used / g.hard);
          else if (g.chatUsed > CHAT_SOFT) showBanner("long", chatId, g.chatUsed);
        }
        if (changed) init = { ...init, body: JSON.stringify(body) };
      }
    } catch (e) {
      console.warn("[mcp-always-on] request patch skipped:", e);
    }
    const res = await origFetch.call(this, input, init);
    try {
      if (url.includes(COMPLETIONS)) watchStream(res, chatId);
    } catch (_) {}
    return res;
  };

  // The page loads chat history with XHR. Healthy chats contain a user message, so only parse
  // (the response can be MBs) when none is present.
  const CHAT_URL = /\/api\/v2\/chats\/([0-9a-f-]{36})(?:\?|$)/;
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const m = guard && String(method).toUpperCase() === "GET" && String(url).match(CHAT_URL);
    if (m) {
      this.addEventListener("load", () => {
        try {
          const t = typeof this.responseText === "string" ? this.responseText : "";
          if (!t || /"role"\s*:\s*"user"/.test(t)) return;
          if (guard.isBrokenChat(JSON.parse(t))) showBanner("broken", m[1]);
        } catch (_) {}
      });
    }
    return origOpen.apply(this, arguments);
  };

  // ---- banner + one-click handover ---------------------------------------------------------
  const HANDOVER_KEY = "qwenContextGuard.handover";
  const MESSAGES = {
    warn: (p) => `Context ${Math.round(p * 100)}% used in this task. Qwen has been asked to wrap up.`,
    stop: () => "Context budget reached. Qwen is writing a handover summary; continue in a new chat.",
    long: (n) => `This chat has ${Math.round(n / 1000)} KB of tool output. A new chat will be faster and safer.`,
    broken: () => "This chat lost its first message and can't continue. Your file changes are safe on disk.",
  };
  let banner = null;
  let bannerChat = null;
  let dismissed = new Set();

  function showBanner(kind, chatId, value) {
    const key = `${kind}:${chatId}`;
    if (dismissed.has(key) || !document.body) return;
    lastPath = location.pathname; // so the route-change reset below doesn't remove a fresh banner
    bannerChat = chatId || chatIdFromUrl();
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "qwen-context-guard";
      banner.innerHTML =
        '<span class="qcg-text"></span><button class="qcg-go" type="button">Continue in new chat</button><button class="qcg-x" type="button" aria-label="Dismiss">×</button>';
      const css = document.createElement("style");
      css.textContent =
        "#qwen-context-guard{position:fixed;right:16px;bottom:96px;z-index:2147483000;max-width:min(440px,calc(100vw - 32px));display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;font:13px/1.4 system-ui,sans-serif;background:#1f2328;color:#f0f3f6;box-shadow:0 6px 24px rgba(0,0,0,.25)}" +
        "#qwen-context-guard[data-kind=warn]{border-left:4px solid #d4a72c}#qwen-context-guard[data-kind=long]{border-left:4px solid #4493f8}" +
        "#qwen-context-guard[data-kind=stop],#qwen-context-guard[data-kind=broken]{border-left:4px solid #f85149}" +
        "#qwen-context-guard .qcg-go{flex:none;border:0;border-radius:8px;padding:6px 10px;background:#f0f3f6;color:#1f2328;font-weight:600;cursor:pointer}" +
        "#qwen-context-guard .qcg-x{flex:none;border:0;background:none;color:inherit;font-size:18px;cursor:pointer;opacity:.7}";
      document.head.appendChild(css);
      banner.querySelector(".qcg-x").onclick = () => {
        dismissed.add(banner.dataset.key);
        banner.remove();
      };
      banner.querySelector(".qcg-go").onclick = () => continueInNewChat(bannerChat);
    }
    banner.dataset.kind = kind;
    banner.dataset.key = key;
    banner.querySelector(".qcg-text").textContent = MESSAGES[kind](value);
    if (!banner.isConnected) document.body.appendChild(banner);
  }

  async function continueInNewChat(chatId) {
    const go = banner && banner.querySelector(".qcg-go");
    if (go) go.textContent = "Preparing handover…";
    try {
      const id = chatId || chatIdFromUrl();
      const j = await origFetch(`/api/v2/chats/${id}`).then((r) => r.json());
      sessionStorage.setItem(HANDOVER_KEY, guard.buildHandover(j));
      location.assign("/");
    } catch (e) {
      if (go) go.textContent = "Couldn't build handover";
      console.warn("[context-guard] handover failed:", e);
    }
  }

  // On the new chat page, drop the handover into the input box for the user to review and send.
  function fillHandover() {
    const text = sessionStorage.getItem(HANDOVER_KEY);
    if (!text) return;
    let tries = 0;
    const timer = setInterval(() => {
      const ta = document.querySelector("textarea");
      if (!ta && ++tries < 60) return;
      clearInterval(timer);
      if (!ta) return;
      sessionStorage.removeItem(HANDOVER_KEY);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
    }, 250);
  }

  // Reset per-chat banners when the user moves to another chat.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (banner) banner.remove();
  }, 1000);

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
    fillHandover();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attachDom, { once: true });
  else attachDom();

  syncServers().catch((e) => console.warn("[mcp-always-on] initial sync failed:", e));
})();
