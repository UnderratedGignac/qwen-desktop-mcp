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
      'Use for git, npm, node, python, dir/ls, ipconfig, etc. Long output is truncated (head and tail kept). ' +
      'For anything that may take over ~2 minutes (installs, builds, test suites, dev servers) use start_job instead.',
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
  {
    name: 'start_job',
    description:
      'Start a long-running command in the background and return a job_id immediately (no timeout). ' +
      'Then poll with job_output. Use for npm install, builds, test suites, dev servers.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        cwd: { type: 'string', description: `Working directory (default ${DEFAULT_CWD}).` },
        shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Shell to use (default powershell).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description:
      'Get output a background job produced since the last call, plus its status (running/finished/failed/stopped) and exit code. ' +
      'Set wait_ms (max 60000) to wait for new output; add until_done to wait for the job to end.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_ms: { type: 'number', description: 'How long to wait for new output, in milliseconds.' },
        until_done: { type: 'boolean', description: 'Keep waiting (up to wait_ms) until the job ends.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'job_stop',
    description: 'Stop a background job and everything it started.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  },
  { name: 'list_jobs', description: 'List background jobs and their status.', inputSchema: { type: 'object', properties: {} } },
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

function spawnShell({ command, cwd, shell }) {
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
  const child = spawn(exe, args, { cwd: cwd || DEFAULT_CWD, windowsHide: true, windowsVerbatimArguments: shell === 'cmd' });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return { child, exe };
}

// ---- background jobs: long commands (builds, installs, dev servers) never hit a tool timeout ----
const JOB_RETAIN_MS = 60 * 60000;
const MAX_JOBS = 20;
const JOB_BUFFER_CHARS = 2000000;
const jobs = new Map();
let jobSeq = 0;

function startJob({ command, cwd, shell }) {
  for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.endedAt > JOB_RETAIN_MS) jobs.delete(id);
  if ([...jobs.values()].filter((j) => j.status === 'running').length >= MAX_JOBS) throw new Error(`Too many running jobs (max ${MAX_JOBS}); stop some with job_stop.`);
  const { child, exe } = spawnShell({ command, cwd, shell });
  const job = { id: `job-${++jobSeq}`, command, startedAt: Date.now(), endedAt: 0, status: 'running', exitCode: null, buf: '', cursor: 0, pid: child.pid, waiters: [] };
  const wake = () => job.waiters.splice(0).forEach((w) => w());
  const append = (d) => {
    job.buf += d;
    if (job.buf.length > JOB_BUFFER_CHARS) {
      const drop = job.buf.length - JOB_BUFFER_CHARS;
      job.buf = job.buf.slice(drop);
      job.cursor = Math.max(0, job.cursor - drop);
    }
    wake();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (err) => { append(`Failed to start ${exe}: ${err.message}\n`); job.status = 'failed'; job.endedAt = Date.now(); wake(); });
  child.on('close', (code) => {
    if (job.status === 'running') job.status = code === 0 ? 'finished' : 'failed';
    job.exitCode = code;
    job.endedAt = Date.now();
    wake();
  });
  jobs.set(job.id, job);
  return job;
}

const getJob = (id) => {
  const j = jobs.get(id);
  if (!j) throw new Error(`Unknown job: ${id}. Use list_jobs to see current jobs.`);
  return j;
};

async function jobOutput({ job_id, wait_ms, until_done }) {
  const j = getJob(job_id);
  const deadline = Date.now() + Math.min(Math.max(Number(wait_ms) || 0, 0), 60000);
  while (Date.now() < deadline) {
    const hasNew = j.buf.length > j.cursor;
    if (j.status !== 'running') break;
    if (hasNew && !until_done) break;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, Math.min(250, Math.max(deadline - Date.now(), 1)));
      j.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  const fresh = j.buf.slice(j.cursor);
  j.cursor = j.buf.length;
  const output = capOutput(fresh.replace(/\s+$/, ''));
  return { job_id: j.id, status: j.status, exit_code: j.exitCode, running_for_ms: (j.endedAt || Date.now()) - j.startedAt, output };
}

function stopJob({ job_id }) {
  const j = getJob(job_id);
  if (j.status === 'running') {
    j.status = 'stopped';
    j.endedAt = Date.now();
    killTree(j.pid);
  }
  return { job_id: j.id, status: j.status };
}

const listJobs = () => ({
  jobs: [...jobs.values()].map((j) => ({ job_id: j.id, status: j.status, command: j.command.slice(0, 120), running_for_ms: (j.endedAt || Date.now()) - j.startedAt })),
});

process.on('exit', () => jobs.forEach((j) => j.status === 'running' && killTree(j.pid)));

function runCommand({ command, cwd, shell, timeout }) {
  return new Promise((resolve) => {
    const ms = Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let out = '';
    let timedOut = false;
    const { child, exe } = spawnShell({ command, cwd, shell });
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
      const name = params?.name;
      const args = params?.arguments || {};
      const json = (obj, isError = false) => reply(id, { content: [{ type: 'text', text: JSON.stringify(obj) }], isError });
      const fail = (msg) => reply(id, { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
      try {
        if (name === 'run_command') {
          if (!args.command) return fail('command is required.');
          const r = await runCommand(args);
          return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
        }
        if (name === 'start_job') {
          if (!args.command) return fail('command is required.');
          const j = startJob(args);
          return json({ job_id: j.id, status: j.status });
        }
        if (name === 'job_output') return json(await jobOutput(args));
        if (name === 'job_stop') return json(stopJob(args));
        if (name === 'list_jobs') return json(listJobs());
      } catch (e) {
        return fail(e.message);
      }
      return replyError(id, -32602, `Unknown tool: ${name}`);
    }
    default:
      if (id !== undefined && !String(method).startsWith('notifications/')) replyError(id, -32601, `Method not found: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('[terminal-mcp]', err));
