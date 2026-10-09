// Terminal MCP server for Qwen Desktop (stdio, line-delimited JSON-RPC 2.0, zero dependencies).
// Runs one command per call in PowerShell (default) or cmd, with no profile load, UTF-8 I/O,
// a hard timeout that kills the whole process tree, and output capped so the model stays fast.
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const DEFAULT_CWD = process.env.USERPROFILE || 'C:\\';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 30 * 60000;
const MAX_OUTPUT_CHARS = 60000; // head + tail kept when exceeded
const HEAD_CHARS = 15000;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const TOOLS = [
  {
    name: 'run_command',
    description:
      'Run a command on the local Windows machine and return its output and exit code. ' +
      'Default shell is PowerShell (no profile); set shell to "cmd" for cmd.exe syntax. ' +
      'Use for git, npm, node, python, dir/ls, ipconfig, etc. Long output is truncated (head and tail kept).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        cwd: { type: 'string', description: `Working directory (default ${DEFAULT_CWD}).` },
        shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Shell to use (default powershell).' },
        timeout: { type: 'number', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` },
      },
      required: ['command'],
    },
  },
];

function capOutput(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const tailChars = MAX_OUTPUT_CHARS - HEAD_CHARS;
  const omitted = s.length - MAX_OUTPUT_CHARS;
  return `${s.slice(0, HEAD_CHARS)}\n\n... [output truncated: ${omitted} characters omitted] ...\n\n${s.slice(-tailChars)}`;
}

function killTree(pid) {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function runCommand({ command, cwd, shell, timeout }) {
  return new Promise((resolve) => {
    const ms = Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let exe, args;
    if (shell === 'cmd') {
      exe = process.env.ComSpec || 'cmd.exe';
      // chcp 65001 switches the console to UTF-8 so non-ASCII output is not mangled
      args = ['/d', '/s', '/c', `chcp 65001>nul & ${command}`];
    } else {
      exe = 'powershell.exe';
      const prelude =
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue";';
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command];
    }
    let out = '';
    let timedOut = false;
    const child = spawn(exe, args, { cwd: cwd || DEFAULT_CWD, windowsHide: true, windowsVerbatimArguments: shell === 'cmd' });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Keep memory bounded even for runaway output: retain at most ~4x the cap.
    const append = (d) => {
      out += d;
      if (out.length > MAX_OUTPUT_CHARS * 4) out = out.slice(0, HEAD_CHARS) + out.slice(-(MAX_OUTPUT_CHARS * 4 - HEAD_CHARS));
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, ms);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ text: `Failed to start ${exe}: ${err.message}`, isError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = capOutput(out.replace(/\s+$/, ''));
      if (timedOut) text += `${text ? '\n' : ''}[Command timed out after ${ms} ms and was killed]`;
      else if (code !== 0) text += `${text ? '\n' : ''}[exit code ${code}]`;
      resolve({ text: text || '(completed with no output)', isError: timedOut || code !== 0 });
    });
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'Terminal', version: '2.0.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'run_command') return replyError(id, -32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments || {};
      if (!args.command) return reply(id, { content: [{ type: 'text', text: 'Error: command is required.' }], isError: true });
      const r = await runCommand(args);
      return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default:
      if (id !== undefined && !String(method).startsWith('notifications/')) replyError(id, -32601, `Method not found: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('[terminal-mcp]', err));
