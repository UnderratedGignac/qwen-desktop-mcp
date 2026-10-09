"use strict";
// Hooks: run things when Qwen does something. The chat page reports a small whitelisted set of events;
// what happens for each event comes ONLY from %USERPROFILE%\.qwen-mcp\hooks.json, never from the page.
//
//   { "hooks": { "turn_finished": [ {"type":"notify"}, {"type":"command","command":"powershell -File C:\\x\\done.ps1"} ] } }
//
// Event data is passed to commands as QWEN_* environment variables and as JSON on stdin; it is never
// interpolated into the command line, so chat text cannot inject commands.
const EVENTS = ["turn_started", "turn_finished", "turn_failed", "budget_stop", "auto_compact", "stuck_released"];

const defaultConfig = () => ({
  hooks: {
    turn_finished: [{ type: "notify" }],
    turn_failed: [{ type: "notify" }],
    auto_compact: [{ type: "notify" }],
  },
});

const clean = (s, n) => String(s == null ? "" : s).replace(/[\r\n\u0000-\u001f]+/g, " ").slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

function sanitizeEvent(raw) {
  if (!raw || typeof raw !== "object" || raw.type !== "qwen-hook" || !EVENTS.includes(raw.event)) return null;
  return {
    event: raw.event,
    chatId: clean(raw.chatId, 64),
    title: clean(raw.title, 120),
    durationMs: num(raw.durationMs),
    toolsRan: num(raw.toolsRan),
    detail: clean(raw.detail, 200),
  };
}

function parseConfig(text) {
  const base = defaultConfig();
  let user;
  try { user = JSON.parse(text); } catch (_) { return base; }
  if (!user || typeof user.hooks !== "object") return base;
  for (const ev of Object.keys(user.hooks)) {
    if (!EVENTS.includes(ev) || !Array.isArray(user.hooks[ev])) continue;
    base.hooks[ev] = user.hooks[ev].filter(
      (h) => h && ((h.type === "notify") || (h.type === "command" && typeof h.command === "string" && h.command.trim()))
    );
  }
  return base;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const TITLES = {
  turn_started: "Qwen started working",
  turn_finished: "Qwen finished",
  turn_failed: "Qwen hit an error",
  budget_stop: "Qwen reached its context budget",
  auto_compact: "Qwen continued in a new chat",
  stuck_released: "Qwen released a stuck chat",
};

function notificationFor(ev) {
  const parts = [];
  if (ev.title) parts.push(ev.title);
  const stats = [];
  if (ev.durationMs) stats.push(formatDuration(ev.durationMs));
  if (ev.toolsRan) stats.push(`${ev.toolsRan} tool call${ev.toolsRan === 1 ? "" : "s"}`);
  if (stats.length) parts.push(stats.join(", "));
  if (ev.detail) parts.push(ev.detail);
  return { title: TITLES[ev.event], body: parts.join(" · ") };
}

// deps: { spawn(cmd, env, stdin), notify({title, body}), isFocused(), profile }
async function runHooks(ev, config, deps) {
  if (!ev) return;
  for (const hook of (config.hooks && config.hooks[ev.event]) || []) {
    try {
      if (hook.type === "notify") {
        if (hook.always || !deps.isFocused()) deps.notify(notificationFor(ev));
      } else if (hook.type === "command") {
        const env = {
          QWEN_EVENT: ev.event,
          QWEN_CHAT_ID: ev.chatId,
          QWEN_CHAT_TITLE: ev.title,
          QWEN_DURATION_MS: String(ev.durationMs),
          QWEN_TOOLS_RAN: String(ev.toolsRan),
          QWEN_DETAIL: ev.detail,
          QWEN_PROFILE: deps.profile || "",
        };
        deps.spawn(hook.command, env, JSON.stringify(ev));
      }
    } catch (_) {
      /* one broken hook must not stop the rest */
    }
  }
}

module.exports = { EVENTS, defaultConfig, sanitizeEvent, parseConfig, runHooks, formatDuration, notificationFor };
