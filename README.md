# qwen-desktop-mcp

Patch for the **Qwen Desktop** app on Windows (`C:\Program Files\Qwen\Qwen.exe`) that makes local MCP
tools always on, fast and prompt-free.

- **Always on:** every chat request carries the local MCP tools, whether or not the MCP toggle in the UI is on.
- **No prompts:** the per-chat "Allow `<tool>` (local) to run?" prompt is answered "Allow in this chat"
  automatically, and hidden so it never flashes.
- **Built-in servers:** Filesystem (your user folder + `C:\`) and Terminal (PowerShell/cmd) are always configured.
- **Faster and more reliable** than the stock proxy (`@ali/spark-mcp`):
  - one persistent process per server, shared by concurrent calls
  - no restart on every message
  - no leaked processes
  - cached tool lists
  - auto-reconnect when a server dies
- **Terminal server:**
  - PowerShell starts without your profile
  - UTF-8 output
  - a hard timeout kills the whole process tree
  - output is capped at 60k characters (head and tail kept), so huge outputs don't slow the model down
- **No env leak:** the stock app sent the MCP config, including **all your environment variables**, to the
  chat.qwen.ai web page. The patch no longer does.
- **Context guard:** prevents and recovers from "Invalid input, the first message must not assistant
  message" (details below).

## Context guard

**Why chats broke:** Qwen's server replays every tool result of a turn on each tool step. One broken
chat had a single turn of ~40 tool calls with 623 KB of output (one `read_file` alone returned 263 KB).
At that size the conversation's first message, your request, got dropped. The model then sees a
conversation starting with an assistant message and refuses every further request.

The guard handles this in three layers:

1. **Result cap (main process, every server).** A tool result over 20,000 characters keeps its head and
   tail, plus a note telling the model to read smaller ranges or search instead. Oversized images or
   blobs are dropped.
2. **Turn budget (in the page).** Tool output going back to the model is counted per turn:
   - Over 150,000 characters: each result gets a "wrap up" note.
   - Over 220,000 characters: results are withheld and the model is told to stop calling tools and write
     a handover summary (what was done, files changed, what's left, next step).

   The turn then ends normally instead of breaking the chat.
3. **Detection and one-click recovery.** A banner appears when:
   - a turn hits the budget,
   - a chat accumulates more than 300 KB of tool output, or
   - you open a chat whose stored history has no user message (already broken).

   **Continue in new chat** builds a handover from the chat's data and puts it in a new chat's input box
   for you to review and send. The handover covers the project folder, files changed (including ones
   touched by terminal commands), recent commands and the last progress note.

To tune the limits, run this in the chat page's DevTools console (or over the remote-debugging port):

```js
localStorage["qwenContextGuard.limits"] = '{"turnSoft":100000,"turnHard":160000}'
```

Your file changes are always safe: tools write straight to disk, so only the chat is affected.

## Layout

| Path | What |
| --- | --- |
| `src/main/mcp-manager.js` | Drop-in replacement for the spark-mcp `Proxy` (main process) |
| `src/preload/mcp-always-on.js` | Script injected into chat.qwen.ai: tool injection, auto-approve, guard UI |
| `src/shared/context-guard.js` | Pure guard logic (result cap, turn budget, broken-chat check, handover) |
| `scripts/patch-bundle.js` | Applies the patch to an extracted stock `app.asar`; fails loudly if Qwen changed |
| `scripts/build.ps1` | Stock `app.asar(.bak)` → `dist\app.asar`, deploys servers to `~\.qwen-mcp` |
| `servers/` | Zero-dependency Filesystem and Terminal MCP servers |
| `installer/` | `install_qwen_patch.bat` / `restore_qwen.bat` (run as administrator) |
| `tests/` | Contract tests for both servers and the manager |

Qwen's own code (`app.asar`) is not in this repo. It is rebuilt locally from your installed copy.

## Use

```bash
npm install
npm test
npm run build
```

Then right-click `installer\install_qwen_patch.bat` → **Run as administrator**, and start Qwen normally
(not as admin). The installer keeps the stock bundle as `resources\app.asar.bak`;
`installer\restore_qwen.bat` puts it back.

A Qwen auto-update replaces `app.asar`. Re-run `npm run build` and the installer afterwards. If
`patch-bundle.js` reports a missing anchor, the update changed the code being patched.

## Security note

The chat model runs on Alibaba's servers. With this patch it can read and write any file on `C:\` and run
any command as you, **without asking**. Text the model reads (web pages, files, search results) can try
to steer it into doing that (prompt injection). Keep that in mind before asking it to process untrusted
content. Run `restore_qwen.bat`, or remove the Terminal entry in `scripts/patch-bundle.js`, if you want
that capability gone.

## Multiple accounts

Run several Qwen accounts side by side, each with its own login:

```powershell
powershell -File scripts\qwen-accounts.ps1                      # Account 1..3
powershell -File scripts\qwen-accounts.ps1 -Names Work,Personal  # your own names
powershell -File scripts\qwen-accounts.ps1 -Remove               # remove shortcuts (logins kept)
```

- Account 1 is your existing Qwen profile.
- Every other account gets its own folder under `%APPDATA%\Qwen-profiles`. Open it once from its
  shortcut (Start menu → **Qwen Accounts**, or the Desktop) and log in; after that it stays logged in.
- Each window shows its account name in the title bar, and each account runs its own MCP servers.

Using extra accounts to get around per-account usage limits may break Qwen's terms of service.

## Daily-use features

| Feature | What you get |
| --- | --- |
| **Background jobs** (Terminal) | `start_job` / `job_output` / `job_stop` / `list_jobs`: builds, installs and dev servers run without any tool timeout; Qwen polls for output. |
| **`search_content`** (Filesystem) | Real grep (regex, glob, context lines, result cap) instead of Qwen improvising. |
| **Memory** server | `remember` / `recall` / `forget`: notes that persist across chats (`~/.qwen-mcp/memory.json`). |
| **Skills** server | `list_skills` / `load_skill` / `read_skill_file` over SKILL.md folders. Default folder `~/.qwen-mcp/skills` (clone of [qwen-skills](https://github.com/UnderratedGignac/qwen-skills)); more folders in `~/.qwen-mcp/skills.json`. |
| **Hooks** | Run things when Qwen finishes, fails, hits its budget, auto-continues or releases a stuck chat. |
| **Device registry** | Every MCP server found on this PC, switchable with one command. |
| **Doctor** | `npm run doctor`: checks the install, the servers, the registry, skills and accounts. |

### Hooks

`%USERPROFILE%\.qwen-mcp\hooks.json` (created on first start). Events: `turn_started`, `turn_finished`,
`turn_failed`, `budget_stop`, `auto_compact`, `stuck_released`. Defaults show a Windows notification and flash
the taskbar when Qwen finishes or fails while its window is in the background.

```json
{
  "hooks": {
    "turn_finished": [
      { "type": "notify", "always": true },
      { "type": "command", "command": "powershell -File C:\scripts\qwen-done.ps1" }
    ]
  }
}
```

Commands get `QWEN_EVENT`, `QWEN_CHAT_ID`, `QWEN_CHAT_TITLE`, `QWEN_DURATION_MS`, `QWEN_TOOLS_RAN`,
`QWEN_DETAIL`, `QWEN_PROFILE` as environment variables and the same data as JSON on stdin. Chat text is never
put in the command line. Only the events above are accepted from the chat page, and what runs comes only from
this file.

### MCP servers found on this PC

```powershell
npm run mcp -- discover              # scan config files and register every server found (nothing is enabled)
npm run mcp -- list                  # name, state, risk, why
npm run mcp -- enable playwright figma-ro
npm run mcp -- disable playwright
```

The registry (`~/.qwen-mcp/servers.json`) only **points** at each server's definition in its original config
file; API keys and tokens stay where they are and are never copied or printed. Everything starts **off**:
a model on a remote server gets these tools with no approval prompt, and the risk labels (database access,
account access, desktop control, your real browser) cannot tell what a local script does. Every enabled tool
also adds roughly 250 tokens to every request. Changes apply to a running Qwen within a few seconds.
