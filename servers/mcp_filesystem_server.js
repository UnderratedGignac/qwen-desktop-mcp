// Zero-dependency Filesystem MCP server for Qwen Desktop (stdio, line-delimited JSON-RPC 2.0)
// Replaces `bun x -y @modelcontextprotocol/server-filesystem@latest` (11s cold start per call)
// with plain `node` startup (~100ms). Allowed directories are taken from argv.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ALLOWED_DIRS = process.argv.slice(2).map((p) => path.resolve(p));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function normWin(p) {
  return path.resolve(p).replace(/[\\/]+$/, '');
}

function assertAllowed(target) {
  const t = normWin(target).toLowerCase();
  for (const d of ALLOWED_DIRS) {
    const dd = normWin(d).toLowerCase();
    if (t === dd || t.startsWith(dd + path.sep) || t.startsWith(dd + '/')) return target;
  }
  fail(`Access denied to ${target}: outside allowed directories (${ALLOWED_DIRS.join(', ')})`);
}

function resolveIn(p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p);
  return assertAllowed(abs);
}

// Simple glob -> RegExp (supports *, ?, ** paths)
function globToRe(g) {
  let src = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]?');
  src = src.replace(/\u0000/g, '.*').replace(/\u0001/g, '.*');
  return new RegExp('(^|[/\\\\])' + src + '([/\\\\]|$)', 'i');
}

function matchesAny(name, patterns) {
  return (patterns || []).some((g) => globToRe(g).test(name));
}

function sliceLines(text, head, tail) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // ignore trailing-newline artifact
  if (head != null) return lines.slice(0, Number(head)).join('\n');
  if (tail != null) return lines.slice(-Number(tail)).join('\n');
  return text;
}

const MEDIA_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

const IGNORE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', 'app.asar']);

function walk(dir, rel, out, exclude, depth) {
  if (depth > 24 || out.length > 20000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const relp = rel ? rel + '/' + ent.name : ent.name;
    if (matchesAny(relp, exclude) || matchesAny(ent.name, exclude)) continue;
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      out.push({ dir: full, rel: relp + '/' });
      walk(full, relp, out, exclude, depth + 1);
    } else if (ent.isFile()) {
      out.push({ dir: full, rel: relp });
    }
  }
}

const handlers = {
  read_file: ({ path: p, head, tail }) => [{ type: 'text', text: sliceLines(fs.readFileSync(resolveIn(p), 'utf8'), head, tail) }],
  read_text_file: ({ path: p, head, tail }) => [{ type: 'text', text: sliceLines(fs.readFileSync(resolveIn(p), 'utf8'), head, tail) }],
  read_media_file: ({ path: p }) => {
    const abs = resolveIn(p);
    const mime = MEDIA_MIME[path.extname(abs).toLowerCase()];
    if (!mime) fail(`Unsupported media type for ${abs}`);
    if (path.extname(abs).toLowerCase() === '.pdf') {
      return [{ type: 'resource', resource: { uri: 'file:///' + abs.replace(/\\/g, '/'), mimeType: mime } }];
    }
    return [{ type: 'image', data: fs.readFileSync(abs).toString('base64'), mimeType: mime }];
  },
  read_multiple_files: ({ paths }) =>
    (paths || []).map((p) => ({ type: 'text', text: `--- ${p} ---\n${fs.readFileSync(resolveIn(p), 'utf8')}` })),
  write_file: ({ path: p, content, binary }) => {
    const abs = resolveIn(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (binary === 'base64') fs.writeFileSync(abs, Buffer.from(content, 'base64'));
    else fs.writeFileSync(abs, String(content), 'utf8');
    return [{ type: 'text', text: binary ? 'Successfully wrote base64 to ' + abs : 'Successfully wrote text to ' + abs }];
  },
  edit_file: ({ path: p, edits, dryRun }) => {
    const abs = resolveIn(p);
    const orig = fs.readFileSync(abs, 'utf8');
    let next = orig;
    const counts = [];
    for (const e of edits || []) {
      const parts = next.split(e.oldText);
      counts.push(parts.length - 1);
      if (!dryRun) next = parts.join(e.newText);
    }
    if (!dryRun) fs.writeFileSync(abs, next);
    return [{ type: 'text', text: `${dryRun ? 'DRY RUN' : 'Saved'}: ${counts.join(', ')} occurrence(s) replaced in ${abs}` }];
  },
  create_directory: ({ path: p }) => {
    const abs = resolveIn(p);
    fs.mkdirSync(abs, { recursive: true });
    return [{ type: 'text', text: 'Successfully created directory ' + abs }];
  },
  list_directory: ({ path: p }) => {
    const abs = resolveIn(p);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => '[DIR] ' + e.name);
    const files = entries.filter((e) => e.isFile()).map((e) => '[FILE] ' + e.name);
    return [{ type: 'text', text: [...dirs, ...files].join('\n') || '(empty directory)' }];
  },
  list_directory_with_sizes: ({ path: p, sortBy }) => {
    const abs = resolveIn(p);
    const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
      let size = 0;
      try { size = e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0; } catch (_) {}
      return { name: e.name, dir: e.isDirectory(), size };
    });
    if (sortBy === 'size') entries.sort((a, b) => (b.dir - a.dir) || (b.size - a.size));
    else entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    const lines = entries.map((e) => `${e.dir ? '[DIR]' : '[FILE]'} ${e.name}${e.dir ? '' : ' (' + fmtSize(e.size) + ')'}`);
    const total = entries.reduce((s, e) => s + e.size, 0);
    lines.push('', `Total: ${entries.length} items, ${fmtSize(total)} (${total} bytes)`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
  directory_tree: ({ path: p, excludePatterns }) => {
    const abs = resolveIn(p);
    const out = [];
    const listing = [];
    const rec = (dir, rel, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of sorted) {
        const full = path.join(dir, e.name);
        const relp = rel ? rel + '/' + e.name : e.name;
        if (matchesAny(relp, excludePatterns)) continue;
        if (e.isDirectory()) {
          listing.push({ type: 'directory', name: e.name });
          if (!IGNORE_DIRS.has(e.name)) rec(full, relp, depth + 1);
        } else if (e.isFile()) {
          listing.push({ type: 'file', name: e.name });
        }
      }
    };
    rec(abs, '', 0);
    return [{ type: 'text', text: JSON.stringify(listing) }];
  },
  move_file: ({ source, destination }) => {
    const src = resolveIn(source);
    const dst = resolveIn(destination);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      if (e.code === 'EXDEV') fs.cpSync(src, dst, { recursive: true }), fs.rmSync(src, { recursive: true, force: true });
      else throw e;
    }
    return [{ type: 'text', text: `Successfully moved ${src} to ${dst}` }];
  },
  search_files: ({ path: p, pattern, excludePatterns }) => {
    const abs = resolveIn(p);
    const re = globToRe(pattern);
    const found = [];
    const items = [];
    walk(abs, '', items, excludePatterns, 0);
    for (const it of items) if (re.test(it.rel)) found.push(path.join(abs, it.rel));
    return [{ type: 'text', text: found.slice(0, 100).join('\n') + (found.length > 100 ? `\n... and ${found.length - 100} more` : '') || 'No matches found' }];
  },
  get_file_info: ({ path: p }) => {
    const abs = resolveIn(p);
    const st = fs.statSync(abs);
    return [{ type: 'text', text: `size: ${st.size}\ncreated: ${st.birthtime.toISOString()}\nmodified: ${st.mtime.toISOString()}\naccessed: ${st.atime.toISOString()}\nisDirectory: ${st.isDirectory()}\nisFile: ${st.isFile()}\npermissions: ${st.mode.toString(8).slice(-3)}` }];
  },
  list_allowed_directories: () => [{ type: 'text', text: 'Allowed directories:\n' + ALLOWED_DIRS.join('\n') }],
};

function fmtSize(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// Tool schemas come straight from the cached official definitions so Qwen sees identical tools
// (outputSchema stripped: we return plain text content; declaring an output schema would force structuredContent validation)
let TOOLS = [];
try {
  TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'filesystem_tools.json'), 'utf8'))
    .map(({ outputSchema, ...rest }) => rest);
} catch (_) {}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  if (!line || !line.trim()) return;
  let req;
  try { req = JSON.parse(line.trim()); } catch (_) { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Filesystem', version: '1.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = (params && (params.name || params.toolName)) || '';
    const args = (params && (params.arguments || params.toolArguments)) || {};
    const fn = handlers[name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } });
      return;
    }
    try {
      const content = fn(args);
      send({ jsonrpc: '2.0', id, result: { content, isError: false } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + (e.userFacing ? e.message : (e.stack || e.message)) }], isError: true } });
    }
    return;
  }

  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

process.on('uncaughtException', (err) => { try { console.error('[fs-mcp] crash:', err.message); } catch (_) {} });
