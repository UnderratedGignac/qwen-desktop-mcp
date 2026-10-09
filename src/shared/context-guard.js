// Context guard for Qwen Desktop's local MCP tool loop. Pure functions, no DOM or I/O, so it runs in
// Node (main process, tests) and in the chat page (loaded before mcp-always-on.js).
//
// Problem it prevents: one agentic turn can pile up hundreds of KB of tool output (a single
// read_file returned 263 KB). Qwen's server replays all of it on every tool step; once it no
// longer fits, the start of the conversation (your own message) is dropped and the chat dies with
// "the first message must not assistant message".
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__qwenContextGuard = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    maxResultChars: 20000, // per tool result
    turnSoft: 150000, // tool output per turn before the model is told to wrap up
    turnHard: 220000, // tool output per turn before results are withheld
    maxBinaryChars: 1000000, // base64 images/blobs larger than this are dropped
  };

  function capText(text, max) {
    if (typeof text !== "string" || text.length <= max) return text;
    const head = Math.floor(max * 0.7);
    const tail = max - head;
    const omitted = text.length - head - tail;
    return (
      text.slice(0, head) +
      `\n\n[... ${omitted} characters truncated by the context guard. Do not re-read the whole thing: ` +
      `read a smaller range (read_file with head/tail), or search for what you need ` +
      `(search_files, or Select-String in the terminal). ...]\n\n` +
      text.slice(-tail)
    );
  }

  function capToolResult(result, max = DEFAULTS.maxResultChars, maxBinary = DEFAULTS.maxBinaryChars) {
    if (!result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: result.content.map((c) => {
        if (!c || typeof c !== "object") return c;
        if (c.type === "text") return { ...c, text: capText(c.text, max) };
        const blob = c.data || (c.resource && c.resource.blob);
        if (typeof blob === "string" && blob.length > maxBinary) {
          return { type: "text", text: `[${c.mimeType || c.type} content too large to send (${blob.length} base64 chars); omitted by the context guard.]` };
        }
        return c;
      }),
    };
  }

  // turns: tool output in the current turn per chat; chats: tool output over the chat's lifetime.
  const newState = () => ({ turns: {}, chats: {} });

  // Tool results come back as { Server: [ { tool: "<JSON array of content items>" } ] }.
  function forEachResult(content, fn) {
    for (const server of Object.keys(content)) {
      const calls = content[server];
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!call || typeof call !== "object") continue;
        for (const tool of Object.keys(call)) call[tool] = fn(call[tool], server, tool);
      }
    }
  }

  function appendNote(raw, note) {
    try {
      const items = JSON.parse(raw);
      if (Array.isArray(items)) return JSON.stringify([...items, { type: "text", text: note }]);
    } catch (_) {}
    return `${raw}\n\n${note}`;
  }

  const WARN_NOTE = (used, hard) =>
    `[Context guard: this task has used ${Math.round((used / hard) * 100)}% of its context budget. ` +
    `Finish the current step with as few further tool calls as possible, avoid reading large files, ` +
    `and then reply to the user.]`;
  const STOP_NOTE =
    `[Context guard: the context budget for this task is used up, so this tool result was withheld. ` +
    `Do not call any more tools. Reply to the user now with a handover summary: ` +
    `1) what was done, 2) files changed, 3) what is left, 4) the exact next step. ` +
    `The user will continue in a new chat.]`;

  // Inspects (and may modify in place) a /api/v2/chat/completions request body.
  // Returns { changed, level: "ok" | "warn" | "stop", used, hard }.
  function guardRequest(body, state, limits = {}) {
    const L = { ...DEFAULTS, ...limits };
    const res = { changed: false, level: "ok", used: 0, hard: L.turnHard, chatUsed: 0 };
    if (!body || !Array.isArray(body.messages)) return res;
    const chat = body.chat_id || body.chatId || "_";
    state.chats = state.chats || {};
    res.chatUsed = state.chats[chat] || 0;
    if (body.messages.some((m) => m && m.role === "user")) {
      state.turns[chat] = { chars: 0 };
      return res;
    }
    const turn = (state.turns[chat] = state.turns[chat] || { chars: 0 });
    const startChars = turn.chars;
    for (const m of body.messages) {
      if (!m || m.role !== "function" || !m.content || typeof m.content !== "object") continue;
      const before = turn.chars;
      forEachResult(m.content, (raw) => {
        turn.chars += typeof raw === "string" ? raw.length : 0;
        return raw;
      });
      if (turn.chars > L.turnHard) {
        forEachResult(m.content, () => JSON.stringify([{ type: "text", text: STOP_NOTE }]));
        res.level = "stop";
        res.changed = true;
        turn.chars = before; // withheld output does not count
      } else if (turn.chars > L.turnSoft) {
        forEachResult(m.content, (raw) => appendNote(raw, WARN_NOTE(turn.chars, L.turnHard)));
        res.level = "warn";
        res.changed = true;
      }
    }
    res.used = turn.chars;
    state.chats[chat] = (state.chats[chat] || 0) + (turn.chars - startChars);
    res.chatUsed = state.chats[chat];
    return res;
  }

  // ---- completion errors -------------------------------------------------------------------
  // Matched only inside error-ish JSON fields, so model output that merely mentions them is ignored.
  const ERROR_FIELD = (pattern) => new RegExp(`"(?:message|msg|error|code|details)"\\s*:\\s*"[^"]*(?:${pattern})`, "i");
  const STUCK_ERROR = ERROR_FIELD("the chat is in progress");
  const INTERNAL_ERROR = ERROR_FIELD("internal_error");
  const CONTEXT_ERROR = ERROR_FIELD(
    "first message must not|context length|maximum context|too many tokens|input is too long|exceed[^\"]*(?:token|length|limit)"
  );

  // "stuck": the server still thinks an earlier generation in this chat is running (typically the
  // app was closed mid tool-loop). "context": the conversation no longer fits / lost its start.
  function classifyCompletionError(text) {
    if (typeof text !== "string" || !text) return null;
    if (STUCK_ERROR.test(text)) return "stuck";
    if (CONTEXT_ERROR.test(text)) return "context";
    if (INTERNAL_ERROR.test(text)) return "internal";
    return null;
  }

  // ---- auto-compact ------------------------------------------------------------------------
  const MAX_HOPS = 3;
  const HOP_MARK = (hop, max) => `[auto-continue ${hop}/${max}]`;
  function parseHop(text) {
    const m = typeof text === "string" && text.match(/\[auto-continue (\d+)\/\d+\]/);
    return m ? Number(m[1]) : 0;
  }

  // event: { kind: "stop" | "context" | "broken" | "internal" | ..., hop, toolsRan }
  // An internal error before any tool ran is just a failed reply (resending is safe); after tools ran,
  // resending would redo their side effects, so the work moves to a new chat instead.
  function shouldAutoCompact(event, opts = {}) {
    const maxHops = opts.maxHops != null ? opts.maxHops : MAX_HOPS;
    if (!event || (event.hop || 0) >= maxHops) return false;
    if (event.kind === "stop" || event.kind === "context" || event.kind === "broken") return true;
    if (event.kind === "internal") return (event.toolsRan || 0) > 0;
    return false;
  }

  // ---- broken-chat detection and handover --------------------------------------------------
  const messagesOf = (chatJson) => {
    const d = (chatJson && chatJson.data) || chatJson || {};
    const h = d.chat && d.chat.history;
    return { title: d.title || "", list: h && h.messages ? Object.values(h.messages) : [] };
  };

  function isBrokenChat(chatJson) {
    const { list } = messagesOf(chatJson);
    return list.some((m) => m && m.role === "assistant") && !list.some((m) => m && m.role === "user");
  }

  const CHANGING_TOOLS = new Set(["write_file", "edit_file", "create_directory", "move_file"]);
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const oneLine = (s) => clip(String(s).replace(/\s+/g, " ").trim(), 150);
  // Windows file paths inside a command; directory names may contain spaces, file names may not.
  const WIN_PATH = /[A-Za-z]:\\(?:[^\\/:*?"'<>|\r\n]+\\)*[^\\/:*?"'<>|\r\n\s]+\.[A-Za-z0-9]{1,8}\b/g;

  function commonFolder(paths) {
    const split = paths.map((p) => p.split("\\").slice(0, -1)); // drop file name
    if (!split.length) return "";
    const common = [];
    for (let i = 0; ; i++) {
      const seg = split[0][i];
      if (seg === undefined || !split.every((s) => s[i] !== undefined && s[i].toLowerCase() === seg.toLowerCase())) break;
      common.push(seg);
    }
    return common.length >= 2 ? common.join("\\") : "";
  }

  function buildHandover(chatJson, opts = {}) {
    const { title, list } = messagesOf(chatJson);
    const user = list.filter((m) => m && m.role === "user");
    const assistants = list.filter((m) => m && m.role === "assistant");
    const changed = new Set();
    const touched = new Set(); // paths that appear in terminal commands (may have been changed)
    const commands = [];
    let lastThought = "";
    let lastAnswer = "";
    for (const a of assistants) {
      if (typeof a.content === "string" && a.content.trim()) lastAnswer = a.content.trim();
      for (const item of a.content_list || []) {
        if (!item) continue;
        if ((item.phase === "think" || item.phase === "answer") && typeof item.content === "string" && item.content.trim()) {
          if (item.phase === "think") lastThought = item.content.trim();
          else lastAnswer = item.content.trim();
        }
        const calls = (item.extra && item.extra.local_mcp) || {};
        for (const server of Object.keys(calls)) {
          for (const call of calls[server] || []) {
            const p = (call && call.params) || {};
            if (CHANGING_TOOLS.has(call.tool_name)) {
              if (p.path) changed.add(p.path);
              if (p.destination) changed.add(p.destination);
            }
            if (call.tool_name === "run_command" && p.command) {
              commands.push(oneLine(p.cwd ? `${p.command} (in ${p.cwd})` : p.command));
              for (const f of String(p.command).match(WIN_PATH) || []) touched.add(f);
            }
          }
        }
      }
    }
    for (const f of changed) touched.delete(f);
    const project = commonFolder([...changed, ...touched]);
    const lines = [];
    lines.push(`I'm continuing a task from a previous chat ("${title || "untitled"}") that ran out of context.`);
    if (project) lines.push(`Project folder: ${project}`);
    if (user.length) lines.push("", "Original request:", clip(String(user[0].content || ""), 1500));
    else lines.push("(The original request was lost; the chat title above is the best summary of it.)");
    if (changed.size) lines.push("", "Files already changed (the changes are on disk):", ...[...changed].slice(-25).map((f) => `- ${f}`));
    if (touched.size) lines.push("", "Files used by terminal commands (may also have been changed):", ...[...touched].slice(-15).map((f) => `- ${f}`));
    if (commands.length) lines.push("", "Last commands run:", ...commands.slice(-8).map((c) => `- ${c}`));
    if (opts.summary) lines.push("", "Handover summary written by the previous chat:", clip(String(opts.summary), 2500));
    else {
      const progress = lastAnswer || lastThought;
      if (progress) lines.push("", "Latest progress note:", clip(progress, 1200));
    }
    lines.push(
      "",
      "Please: 1) check the current state first (git status / git diff --stat in the project folder, or read only the changed files above), " +
        "2) tell me in 3-5 bullets where things stand, 3) continue the remaining work. " +
        "Read files in small ranges and keep tool output short."
    );
    if (opts.hop) lines.push("", HOP_MARK(opts.hop, opts.maxHops || MAX_HOPS));
    return lines.join("\n");
  }

  return {
    DEFAULTS,
    MAX_HOPS,
    capText,
    capToolResult,
    newState,
    guardRequest,
    classifyCompletionError,
    parseHop,
    shouldAutoCompact,
    isBrokenChat,
    buildHandover,
  };
});
