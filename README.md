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

## Layout

| Path | What |
| --- | --- |
| `src/main/mcp-manager.js` | Drop-in replacement for the spark-mcp `Proxy` (main process) |
| `src/preload/mcp-always-on.js` | Script injected into chat.qwen.ai: tool injection + auto-approve |
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
