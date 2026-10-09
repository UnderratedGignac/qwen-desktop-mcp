"use strict";
// Multiple Qwen accounts side by side: each account runs with its own --user-data-dir (separate
// login, cookies and settings). The account name shown in the window title comes from
// --qwen-profile=<name>, or from the folder name under %APPDATA%\Qwen-profiles.
const path = require("path");

function profileName(argv, userDataPath) {
  for (const a of argv || []) {
    const m = String(a).match(/^--qwen-profile=(.+)$/);
    if (m) return m[1].replace(/^"(.*)"$/, "$1").trim() || null;
  }
  const dir = String(userDataPath || "");
  if (/[\\/]Qwen-profiles[\\/][^\\/]+[\\/]?$/i.test(dir)) return path.win32.basename(dir.replace(/[\\/]+$/, ""));
  return null;
}

function windowTitle(base, name) {
  if (!name) return base;
  const suffix = ` — ${name}`;
  return base.endsWith(suffix) ? base : base + suffix;
}

module.exports = { profileName, windowTitle };
