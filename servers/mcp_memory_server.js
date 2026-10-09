"use strict";
// Memory MCP server: short notes that persist across chats (project facts, preferences, decisions).
// Stored in QWEN_MEMORY_FILE or %USERPROFILE%\.qwen-mcp\memory.json.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { serve } = require("./lib/mcp-stdio.js");

const FILE = process.env.QWEN_MEMORY_FILE || path.join(os.homedir(), ".qwen-mcp", "memory.json");
const MAX_TEXT = 2000;
const MAX_ENTRIES = 500;
const MAX_RECALL = 20;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(d.memories) ? d : { next: 1, memories: [] };
  } catch (_) {
    return { next: 1, memories: [] };
  }
}
function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE); // atomic: a crash never leaves a half-written file
}

const tools = [
  {
    name: "remember",
    description: "Save a short note that should survive across chats: a project fact, a user preference, a decision, a path. One fact per note.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: `The note (max ${MAX_TEXT} characters).` }, tags: { type: "array", items: { type: "string" } } },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description: "Search saved notes by keywords (all words must match). Without a query returns the newest notes. Check this at the start of work on a known project.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "forget", description: "Delete a saved note by id (from recall).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

const fmt = (m) => `${m.id} [${m.created.slice(0, 10)}]${m.tags.length ? ` {${m.tags.join(", ")}}` : ""} ${m.text}`;

serve({
  name: "Memory",
  tools,
  call(tool, args) {
    const db = load();
    if (tool === "remember") {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("text is required.");
      if (text.length > MAX_TEXT) throw new Error(`Note too long (${text.length} > ${MAX_TEXT}); save a shorter fact.`);
      const m = { id: `mem-${db.next++}`, text, tags: (Array.isArray(args.tags) ? args.tags : []).map(String).slice(0, 8), created: new Date().toISOString() };
      db.memories.push(m);
      if (db.memories.length > MAX_ENTRIES) db.memories.splice(0, db.memories.length - MAX_ENTRIES);
      save(db);
      return `Saved as ${m.id}.`;
    }
    if (tool === "recall") {
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), MAX_RECALL);
      const words = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = db.memories
        .filter((m) => words.every((w) => `${m.text} ${m.tags.join(" ")}`.toLowerCase().includes(w)))
        .reverse()
        .slice(0, limit);
      return hits.length ? hits.map(fmt).join("\n") : args.query ? `No memories match "${args.query}".` : "No memories saved yet.";
    }
    if (tool === "forget") {
      const i = db.memories.findIndex((m) => m.id === args.id);
      if (i < 0) throw new Error(`No memory with id ${args.id}.`);
      db.memories.splice(i, 1);
      save(db);
      return `Forgot ${args.id}.`;
    }
  },
});
