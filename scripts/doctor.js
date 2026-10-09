#!/usr/bin/env node
// One-command health check for the Qwen Desktop patch.  Usage: node scripts/doctor.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const home = os.homedir();
const dir = path.join(home, ".qwen-mcp");
const qwenDir = "C:\\Program Files\\Qwen";
const repo = path.join(__dirname, "..");
const R = require("../src/main/registry.js");

let problems = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, fix) => { problems++; console.log(`  FAIL  ${m}${fix ? `\n        -> ${fix}` : ""}`); };
const note = (m) => console.log(`  info  ${m}`);
const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function toolCount(script, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, script), ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const t = setTimeout(() => { p.kill(); resolve(null); }, 8000);
    p.stdout.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        clearTimeout(t);
        try { resolve(JSON.parse(buf.slice(0, i)).result.tools.length); } catch (_) { resolve(null); }
        p.kill();
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  });
}

(async () => {
  console.log("Qwen Desktop patch: health check\n");

  console.log("Installation");
  const exe = path.join(qwenDir, "Qwen.exe");
  if (!fs.existsSync(exe)) bad("Qwen.exe not found", `install Qwen to ${qwenDir}`);
  else ok("Qwen installed");
  const asar = path.join(qwenDir, "resources", "app.asar");
  const built = path.join(repo, "dist", "app.asar");
  if (fs.existsSync(asar) && fs.existsSync(built)) {
    if (hash(asar) === hash(built)) ok("installed bundle is the latest build");
    else bad("installed bundle differs from the latest build (Qwen auto-updated, or a newer build is waiting)", "npm run build, then run installer\\install_qwen_patch.bat as administrator");
  } else if (!fs.existsSync(built)) note("no dist\\app.asar yet (npm run build)");
  if (!fs.existsSync(path.join(qwenDir, "resources", "app.asar.bak"))) bad("no app.asar.bak backup of the stock bundle");
  else ok("stock bundle backup present (restore_qwen.bat can undo everything)");

  console.log("\nServers (built-in)");
  let total = 0;
  for (const [name, script, args] of [["Filesystem", "mcp_filesystem_server.js", [home]], ["Terminal", "mcp_terminal_server.js", []], ["Memory", "mcp_memory_server.js", []], ["Skills", "mcp_skills_server.js", []]]) {
    if (!fs.existsSync(path.join(dir, script))) { bad(`${name}: ${script} missing in ${dir}`, "npm run build"); continue; }
    const n = await toolCount(script, args);
    if (n == null) bad(`${name}: did not answer tools/list`);
    else { ok(`${name}: ${n} tools`); total += n; }
  }
  if (!fs.existsSync(path.join(dir, "lib", "mcp-stdio.js"))) bad("servers\\lib missing in ~/.qwen-mcp", "npm run build");

  console.log("\nRegistry (servers found on this PC)");
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(path.join(dir, "servers.json"), "utf8")); } catch (_) {}
  if (!reg) note("no registry yet: node scripts\\qwen-mcp.js discover");
  else {
    const all = Object.entries(reg.servers);
    const on = all.filter(([, e]) => e.enabled && !e.missing && e.supported);
    ok(`${all.length} registered, ${on.length} enabled${on.length ? ": " + on.map(([n]) => n).join(", ") : ""}`);
    for (const [n, e] of on) if (e.risk === "high") note(`${n} is enabled and HIGH risk (${(e.reasons || []).join("; ")})`);
  }
  note(`about ${Math.round((total * R.TOKENS_PER_TOOL) / 100) / 10}k tokens of tool definitions per request from built-ins (more for enabled registry servers)`);

  console.log("\nSkills, memory, hooks");
  let skillDirs = 0;
  const skillsRoot = path.join(dir, "skills");
  try { skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsRoot, d.name, "SKILL.md"))).length; } catch (_) {}
  skillDirs ? ok(`${skillDirs} skills in ${skillsRoot}`) : bad("no skills installed", "powershell -File C:\\Users\\" + os.userInfo().username + "\\qwen-skills\\install.ps1");
  try { ok(`${JSON.parse(fs.readFileSync(path.join(dir, "memory.json"), "utf8")).memories.length} saved memories`); } catch (_) { note("no memories saved yet"); }
  try { const h = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8")); ok(`hooks.json: ${Object.keys(h.hooks || {}).join(", ")}`); } catch (_) { note("hooks.json is created the first time the patched Qwen starts"); }

  console.log("\nAccounts");
  const profiles = path.join(process.env.APPDATA || "", "Qwen-profiles");
  try { ok(`profiles: Account 1 (default), ${fs.readdirSync(profiles).join(", ")}`); } catch (_) { note("only the default profile (scripts\\qwen-accounts.ps1 adds more)"); }

  console.log(problems ? `\n${problems} problem${problems === 1 ? "" : "s"} found.` : "\nAll good.");
  process.exit(problems ? 1 : 0);
})();
