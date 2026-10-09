"use strict";
// Skills MCP server: reusable instruction packs (SKILL.md folders) the model can look up and load on
// demand, the same format Claude Code uses. Folders come from QWEN_SKILLS_PATHS (semicolon separated),
// else %USERPROFILE%\.qwen-mcp\skills.json {"paths":[...]}, else %USERPROFILE%\.qwen-mcp\skills.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { serve } = require("./lib/mcp-stdio.js");

const MAX_CHARS = 30000;
const MAX_LIST = 80;

function skillRoots() {
  if (process.env.QWEN_SKILLS_PATHS) return process.env.QWEN_SKILLS_PATHS.split(";").filter(Boolean);
  const home = path.join(os.homedir(), ".qwen-mcp");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "skills.json"), "utf8"));
    if (Array.isArray(cfg.paths) && cfg.paths.length) return cfg.paths;
  } catch (_) {}
  return [path.join(home, "skills")];
}

function parseSkill(file, dirName) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  let name = dirName;
  let description = "";
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const n = fm[1].match(/^name:\s*(.+)$/m);
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (n) name = n[1].trim().replace(/^["']|["']$/g, "");
    if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!description) {
    const body = fm ? text.slice(fm[0].length) : text;
    const para = body.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/^#+\s.*$/gm, "").trim()).find(Boolean);
    description = (para || "").replace(/\s+/g, " ");
  }
  return { name, description: description.slice(0, 200), dir: path.dirname(file), file };
}

function scan() {
  const skills = new Map();
  for (const root of skillRoots()) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    const visit = (dir, depth) => {
      const f = path.join(dir, "SKILL.md");
      if (fs.existsSync(f)) {
        try {
          const s = parseSkill(f, path.basename(dir));
          if (!skills.has(s.name)) skills.set(s.name, s);
        } catch (_) {}
        return;
      }
      if (depth >= 2) return;
      let sub;
      try { sub = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of sub) if (e.isDirectory() && !e.name.startsWith(".")) visit(path.join(dir, e.name), depth + 1);
    };
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) visit(path.join(root, e.name), 1);
  }
  return skills;
}

function find(name) {
  const s = scan().get(name) || [...scan().values()].find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!s) throw new Error(`No skill named "${name}". Call list_skills to see what is available.`);
  return s;
}

const cap = (t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + `\n\n[... truncated at ${MAX_CHARS} characters ...]` : t);

function listFiles(dir, base = dir, out = [], depth = 0) {
  if (depth > 3 || out.length > 50) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out, depth + 1);
    else if (e.name !== "SKILL.md") out.push(path.relative(base, p));
  }
  return out;
}

const tools = [
  {
    name: "list_skills",
    description:
      "List available skills (reusable instruction packs for coding, debugging, Windows/PowerShell, git, review...). " +
      "Call this BEFORE starting a non-trivial task, then load_skill the ones that fit. Optional query filters by keyword.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Keywords to filter by name or description." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "load_skill",
    description: "Load a skill's full instructions (SKILL.md) and list its extra files. Follow the instructions it gives.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_skill_file",
    description: "Read a supporting file that belongs to a skill (path relative to the skill folder, as listed by load_skill).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["name", "file"] },
    annotations: { readOnlyHint: true },
  },
];

serve({
  name: "Skills",
  tools,
  call(tool, args) {
    if (tool === "list_skills") {
      const words = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
      const all = [...scan().values()].filter((s) => words.every((w) => `${s.name} ${s.description}`.toLowerCase().includes(w)));
      if (!all.length) return args.query ? `No skills match "${args.query}".` : `No skills found in: ${skillRoots().join("; ")}`;
      const lines = all.slice(0, MAX_LIST).map((s) => `${s.name} — ${s.description}`);
      if (all.length > MAX_LIST) lines.push(`... and ${all.length - MAX_LIST} more; add a query to narrow down.`);
      return lines.join("\n");
    }
    if (tool === "load_skill") {
      const s = find(args.name);
      const files = listFiles(s.dir);
      const text = fs.readFileSync(s.file, "utf8").replace(/^﻿/, "");
      return cap(text) + (files.length ? `\n\n---\nSupporting files (use read_skill_file):\n${files.map((f) => `- ${f}`).join("\n")}` : "");
    }
    if (tool === "read_skill_file") {
      const s = find(args.name);
      const target = path.resolve(s.dir, String(args.file || ""));
      const rel = path.relative(s.dir, target);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("File must be inside the skill folder.");
      return cap(fs.readFileSync(target, "utf8"));
    }
  },
});
