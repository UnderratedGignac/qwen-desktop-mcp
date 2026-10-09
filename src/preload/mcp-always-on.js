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
  let MANAGED = ["Filesystem", "Terminal"]; // refreshed from the main process: built-ins + enabled registry servers
  const AUTO_MARK = "(local, always on)";
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
    if (window.qwenExtras) {
      try {
        MANAGED = await within(window.qwenExtras.managed(), 1500);
      } catch (_) {}
      // A registry server that was turned off must disappear here too, or it would come back as a "user" server.
      const keep = readServers().filter((s) => !(String(s.description || "").endsWith(AUTO_MARK) && !MANAGED.includes(s.name)));
      localStorage.setItem(KEY, JSON.stringify(keep));
    }
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
          description: `${name} ${AUTO_MARK}`,
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
  // "The chat is in progress!" means the server still has an earlier generation open for this chat,
  // typically because Qwen was closed mid tool-loop. Do what the Stop button does to release it.
  async function releaseChat(chatId) {
    const j = await origFetch(`/api/v2/chats/${chatId}`).then((r) => r.json());
    const h = j.data.chat.history;
    const last = Object.values(h.messages).filter((m) => m && m.role === "assistant").pop();
    if (!last) return false;
    const r = await origFetch(`/api/v2/chat/completions/stop?chat_id=${chatId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Accel-Buffering": "no" },
      body: JSON.stringify({ chat_id: chatId, response_id: last.id }),
    }).then((x) => x.json());
    return !!(r && r.success);
  }

  // Hook events go to the main process, which decides what to do from hooks.json (notification, sound, command).
  function emit(event, chatId, extra = {}) {
    try {
      const info = turnInfo[chatId] || {};
      window.qwenExtras && window.qwenExtras.hook({
        event,
        chatId,
        title: info.title || "",
        durationMs: info.startedAt ? Date.now() - info.startedAt : 0,
        toolsRan: info.toolsRan || 0,
        ...extra,
      });
    } catch (_) {}
  }

  function watchStream(res, chatId, opts = {}) {
    if (!res.body || !guard) return;
    const reader = res.clone().body.getReader();
    const dec = new TextDecoder();
    const tracker = guard.createStreamTracker();
    let carry = "";
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        tracker.push(chunk);
        const text = carry + chunk;
        const kind = guard.classifyCompletionError(text);
        if (kind) {
          reader.cancel().catch(() => {});
          const id = chatId || chatIdFromUrl();
          if (kind === "stuck") {
            const released = id ? await releaseChat(id).catch(() => false) : false;
            if (released) emit("stuck_released", id);
            return showBanner(released ? "released" : "stuck", id);
          }
          emit("turn_failed", id, { detail: kind === "context" ? "context limit" : "server error" });
          return onTurnFailed(id, kind === "context" ? "context" : "internal");
        }
        carry = text.slice(-300);
      }
      const r = tracker.result();
      // A stream that ends in a finished answer is the end of the whole task; one that ends in a tool
      // call just means the app will run the tools and continue with a new request.
      if (r.endedTurn && chatId) emit("turn_finished", chatId);
      if (opts.onDone) opts.onDone(r.answer);
    })().catch(() => {});
  }

  // Per chat: how many tool results went back this turn, and which auto-continue hop we're on.
  const turnInfo = {};
  const infoFor = (id) => (turnInfo[id] = turnInfo[id] || { toolsRan: 0, hop: 0 });

  function onTurnFailed(chatId, kind) {
    const info = infoFor(chatId);
    const event = { kind, hop: info.hop, toolsRan: info.toolsRan };
    if (guard.shouldAutoCompact(event)) return autoCompact(chatId, null, info.hop);
    showBanner(kind === "internal" ? "internal" : "broken", chatId);
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    let chatId = null;
    let streamOpts = {};
    try {
      if (url.includes(COMPLETIONS) && init && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        chatId = body.chat_id || chatIdFromUrl();
        let changed = false;
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const userMsg = msgs.find((m) => m && m.role === "user");
        if (userMsg) {
          const map = await syncServers().catch(() => ({}));
          changed = injectTools(body, map);
          if (guard) {
            const text = String(userMsg.content || "");
            turnInfo[chatId] = { toolsRan: 0, hop: guard.parseHop(text), startedAt: Date.now(), title: text.replace(/\s+/g, " ").slice(0, 60) };
            emit("turn_started", chatId);
          }
        } else if (msgs.some((m) => m && m.role === "function")) {
          infoFor(chatId).toolsRan++;
        }
        if (guard) {
          const g = guard.guardRequest(body, guardState, userLimits());
          changed = changed || g.changed;
          saveChats();
          if (g.level === "stop") {
            // This reply is the model's handover summary; continue in a new chat once it's written.
            const hop = infoFor(chatId).hop;
            const auto = guard.shouldAutoCompact({ kind: "stop", hop });
            showBanner("stop", chatId, auto);
            emit("budget_stop", chatId);
            if (auto) {
              const id = chatId;
              streamOpts = { collectAnswer: true, onDone: (summary) => autoCompact(id, summary, hop) };
            }
          } else if (g.level === "warn") showBanner("warn", chatId, g.used / g.hard);
          else if (g.chatUsed > CHAT_SOFT) showBanner("long", chatId, g.chatUsed);
        }
        if (changed) init = { ...init, body: JSON.stringify(body) };
      }
    } catch (e) {
      console.warn("[mcp-always-on] request patch skipped:", e);
    }
    const res = await origFetch.call(this, input, init);
    try {
      if (url.includes(COMPLETIONS)) watchStream(res, chatId, streamOpts);
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
    stop: (auto) =>
      auto
        ? "Context budget reached. Qwen is writing a handover summary; the work will continue in a new chat automatically."
        : "Context budget reached. Qwen is writing a handover summary; continue in a new chat.",
    long: (n) => `This chat has ${Math.round(n / 1000)} KB of tool output. A new chat will be faster and safer.`,
    broken: () => "This chat lost its first message and can't continue. Your file changes are safe on disk.",
    released: () => "An earlier step in this chat was still open on Qwen's server (Qwen was probably closed mid-task). It's been released: send your message again.",
    stuck: () => "Qwen's server still thinks an earlier step in this chat is running. Wait a minute and send again, or continue in a new chat.",
    internal: () => "Qwen's server failed mid-task (internal error). Your file changes are safe on disk.",
    continued: (h) => `Continued automatically from "${h.from.title}" (step ${h.hop}/${guard.MAX_HOPS}).`,
  };
  const BUTTONS = { continued: "Open previous chat" };
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
        "#qwen-context-guard[data-kind=warn],#qwen-context-guard[data-kind=stuck]{border-left:4px solid #d4a72c}" +
        "#qwen-context-guard[data-kind=long],#qwen-context-guard[data-kind=released],#qwen-context-guard[data-kind=continued]{border-left:4px solid #4493f8}" +
        "#qwen-context-guard[data-kind=stop],#qwen-context-guard[data-kind=broken],#qwen-context-guard[data-kind=internal]{border-left:4px solid #f85149}" +
        "#qwen-context-guard .qcg-go{flex:none;border:0;border-radius:8px;padding:6px 10px;background:#f0f3f6;color:#1f2328;font-weight:600;cursor:pointer}" +
        "#qwen-context-guard .qcg-x{flex:none;border:0;background:none;color:inherit;font-size:18px;cursor:pointer;opacity:.7}";
      document.head.appendChild(css);
      banner.querySelector(".qcg-x").onclick = () => {
        dismissed.add(banner.dataset.key);
        banner.remove();
      };
      banner.querySelector(".qcg-go").onclick = () => {
        if (banner.dataset.kind === "continued" && continuedFrom) location.assign(`/c/${continuedFrom.id}`);
        else continueInNewChat(bannerChat);
      };
    }
    banner.dataset.kind = kind;
    banner.dataset.key = key;
    banner.querySelector(".qcg-text").textContent = MESSAGES[kind](value);
    banner.querySelector(".qcg-go").textContent = BUTTONS[kind] || "Continue in new chat";
    if (!banner.isConnected) document.body.appendChild(banner);
  }

  // Builds the handover from the chat's stored data and opens a new chat with it. With auto=true
  // the new chat sends it by itself (auto-compact); otherwise it waits in the input box.
  async function startHandover(chatId, { summary = null, hop = 0, auto = false } = {}) {
    const go = banner && banner.querySelector(".qcg-go");
    if (go) go.textContent = "Preparing handover…";
    try {
      const id = chatId || chatIdFromUrl();
      const j = await origFetch(`/api/v2/chats/${id}`).then((r) => r.json());
      const text = guard.buildHandover(j, { summary, hop: auto ? hop + 1 : 0 });
      const title = (j.data && j.data.title) || "previous chat";
      if (auto) emit("auto_compact", id, { title, detail: `step ${hop + 1}/${guard.MAX_HOPS}` });
      sessionStorage.setItem(HANDOVER_KEY, JSON.stringify({ text, auto, from: { id, title }, hop: hop + 1 }));
      location.assign("/");
    } catch (e) {
      if (go) go.textContent = "Couldn't build handover";
      console.warn("[context-guard] handover failed:", e);
    }
  }
  const continueInNewChat = (chatId) => startHandover(chatId);
  const autoCompact = (chatId, summary, hop) => startHandover(chatId, { summary, hop, auto: true });

  // On the new chat page: put the handover in the input box, and send it if this is auto-compact.
  function fillHandover() {
    let h;
    try {
      h = JSON.parse(sessionStorage.getItem(HANDOVER_KEY) || "null");
    } catch (_) {}
    if (!h || !h.text) return;
    let tries = 0;
    const timer = setInterval(() => {
      const ta = document.querySelector("textarea");
      if (!ta && ++tries < 60) return;
      clearInterval(timer);
      if (!ta) return;
      sessionStorage.removeItem(HANDOVER_KEY);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, h.text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      if (!h.auto) return;
      setTimeout(() => {
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        continuedFrom = h.from;
        showBanner("continued", null, h);
      }, 700);
    }, 250);
  }
  let continuedFrom = null;

  // Reset per-chat banners when the user moves to another chat.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    // The new chat gets its /c/<id> URL right after the handover is sent; keep that banner.
    if (banner && banner.dataset.kind === "continued" && !banner.dataset.moved) {
      banner.dataset.moved = "1";
      return;
    }
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
