// Unit tests for src/shared/context-guard.js. Usage: node tests/test_context_guard.js
const assert = require('assert');
const G = require('../src/shared/context-guard.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

// Builds a request body like the one Qwen sends back after a tool call.
const fnBody = (chatId, server, tool, text) => ({
  chat_id: chatId,
  messages: [{ role: 'function', content: { [server]: [{ [tool]: JSON.stringify([{ type: 'text', text }]) }] } }],
});
const userBody = (chatId, text = 'do the thing') => ({ chat_id: chatId, messages: [{ role: 'user', content: text }] });
const resultText = (body) => {
  const [server] = Object.keys(body.messages[0].content);
  const entry = body.messages[0].content[server][0];
  return JSON.parse(Object.values(entry)[0]).map((c) => c.text).join('\n');
};

check('capText leaves short text alone', () => {
  assert.strictEqual(G.capText('hello', 100), 'hello');
});
check('capText keeps head and tail and explains how to read more', () => {
  const big = 'HEAD' + 'x'.repeat(100000) + 'TAIL';
  const out = G.capText(big, 20000);
  assert.ok(out.length <= 20600, `length ${out.length}`);
  assert.ok(out.startsWith('HEAD'));
  assert.ok(out.endsWith('TAIL'));
  assert.match(out, /truncated/i);
  assert.match(out, /head|tail|search/i);
});
check('capToolResult caps text items and drops oversized binary blobs', () => {
  const r = G.capToolResult({ content: [
    { type: 'text', text: 'y'.repeat(50000) },
    { type: 'image', data: 'A'.repeat(3_000_000), mimeType: 'image/png' },
    { type: 'image', data: 'B'.repeat(1000), mimeType: 'image/png' },
  ] }, 20000);
  assert.ok(r.content[0].text.length < 21000);
  assert.strictEqual(r.content[1].type, 'text');
  assert.match(r.content[1].text, /too large/i);
  assert.strictEqual(r.content[2].type, 'image');
});
check('capToolResult passes through non-content results', () => {
  assert.deepStrictEqual(G.capToolResult(null, 10), null);
  assert.deepStrictEqual(G.capToolResult({ isError: true }, 10), { isError: true });
});

const limits = { turnSoft: 1000, turnHard: 2000 };
check('a user message starts a fresh turn', () => {
  const st = G.newState();
  G.guardRequest(fnBody('c1', 'Filesystem', 'read_file', 'a'.repeat(1500)), st, limits);
  const r = G.guardRequest(userBody('c1'), st, limits);
  assert.strictEqual(st.turns.c1.chars, 0);
  assert.strictEqual(r.level, 'ok');
});
check('tool results accumulate per chat; small turns are untouched', () => {
  const st = G.newState();
  G.guardRequest(userBody('c1'), st, limits);
  const b = fnBody('c1', 'Terminal', 'run_command', 'z'.repeat(300));
  const r = G.guardRequest(b, st, limits);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.level, 'ok');
  assert.ok(st.turns.c1.chars >= 300);
  G.guardRequest(fnBody('c2', 'Terminal', 'run_command', 'z'.repeat(900)), st, limits);
  assert.ok(st.turns.c1.chars < 1000, 'other chats must not count');
});
check('past the soft limit the model is told to wrap up', () => {
  const st = G.newState();
  G.guardRequest(userBody('c1'), st, limits);
  G.guardRequest(fnBody('c1', 'Filesystem', 'read_file', 'a'.repeat(900)), st, limits);
  const b = fnBody('c1', 'Filesystem', 'read_file', 'b'.repeat(300));
  const r = G.guardRequest(b, st, limits);
  assert.strictEqual(r.level, 'warn');
  assert.strictEqual(r.changed, true);
  const t = resultText(b);
  assert.match(t, /b{300}/, 'real result is still delivered');
  assert.match(t, /context/i);
});
check('past the hard limit results are withheld and a handover summary is demanded', () => {
  const st = G.newState();
  G.guardRequest(userBody('c1'), st, limits);
  G.guardRequest(fnBody('c1', 'Filesystem', 'read_file', 'a'.repeat(1900)), st, limits);
  const b = fnBody('c1', 'Filesystem', 'read_file', 'SECRETPAYLOAD'.repeat(50));
  const r = G.guardRequest(b, st, limits);
  assert.strictEqual(r.level, 'stop');
  const t = resultText(b);
  assert.doesNotMatch(t, /SECRETPAYLOAD/);
  assert.match(t, /do not call any more tools/i);
  assert.match(t, /summary/i);
});
check('chat totals accumulate across turns (for the "start a new chat" hint)', () => {
  const st = G.newState();
  for (let i = 0; i < 3; i++) {
    G.guardRequest(userBody('c9'), st, limits);
    G.guardRequest(fnBody('c9', 'Terminal', 'run_command', 'q'.repeat(500)), st, limits);
  }
  const r = G.guardRequest(fnBody('c9', 'Terminal', 'run_command', 'q'.repeat(10)), st, limits);
  assert.ok(st.chats.c9 >= 1500, `chat total ${st.chats.c9}`);
  assert.ok(r.chatUsed >= 1500);
});
check('malformed or unrelated bodies are ignored safely', () => {
  const st = G.newState();
  assert.strictEqual(G.guardRequest({}, st, limits).changed, false);
  assert.strictEqual(G.guardRequest({ chat_id: 'x', messages: [{ role: 'function', content: 'plain' }] }, st, limits).changed, false);
});

// Shaped like GET /api/v2/chats/{id} for a chat whose user message was lost.
const brokenChat = {
  data: {
    title: 'Enhance 3D Kick Game',
    chat: { history: { currentId: 'a1', messages: {
      a1: { id: 'a1', role: 'assistant', parentId: null, content: '', content_list: [
        { phase: 'think', content: 'First, check the directory.' },
        { phase: 'local_tool', mcp_name: 'Filesystem', tool_name: 'read_file', extra: { local_mcp: { Filesystem: [{ tool_name: 'read_file', params: { path: 'C:\\proj\\src\\game.ts' } }] } } },
        { phase: 'local_tool', mcp_name: 'Filesystem', tool_name: 'edit_file', extra: { local_mcp: { Filesystem: [{ tool_name: 'edit_file', params: { path: 'C:\\proj\\src\\physics.ts', edits: [] } }] } } },
        { phase: 'local_tool', mcp_name: 'Filesystem', tool_name: 'write_file', extra: { local_mcp: { Filesystem: [{ tool_name: 'write_file', params: { path: 'C:\\proj\\src\\spin.test.ts', content: 'x' } }] } } },
        { phase: 'local_tool', mcp_name: 'Terminal', tool_name: 'run_command', extra: { local_mcp: { Terminal: [{ tool_name: 'run_command', params: { command: 'npm run test', cwd: 'C:\\proj' } }] } } },
        { phase: 'think', content: 'Tests pass for physics; spin tests still failing on curve direction.' },
      ] },
    } } },
  },
};
check('isBrokenChat detects a history with no user message', () => {
  assert.strictEqual(G.isBrokenChat(brokenChat), true);
  const ok = JSON.parse(JSON.stringify(brokenChat));
  ok.data.chat.history.messages.u1 = { id: 'u1', role: 'user', content: 'hi' };
  assert.strictEqual(G.isBrokenChat(ok), false);
});
check('buildHandover lists the task, changed files, commands and latest progress', () => {
  const h = G.buildHandover(brokenChat);
  assert.match(h, /Enhance 3D Kick Game/);
  assert.match(h, /physics\.ts/);
  assert.match(h, /spin\.test\.ts/);
  assert.doesNotMatch(h, /- C:\\proj\\src\\game\.ts/, 'files only read are not listed as changed');
  assert.match(h, /npm run test/);
  assert.match(h, /spin tests still failing/);
  assert.match(h, /git status|git diff/i);
  assert.ok(h.length < 6000, `handover length ${h.length}`);
});
check('buildHandover keeps each command to one short line', () => {
  const c = JSON.parse(JSON.stringify(brokenChat));
  c.data.chat.history.messages.a1.content_list.push({ phase: 'local_tool', extra: { local_mcp: { Terminal: [{ tool_name: 'run_command', params: {
    command: "python -c \"\npath = r'C:\\proj\\src\\curve.ts'\nwith open(path, 'w') as f:\n    f.write('x' * 500)\n\"" } }] } } });
  const h = G.buildHandover(c);
  const cmdLines = h.split('\n').filter((l) => l.startsWith('- python'));
  assert.strictEqual(cmdLines.length, 1, h);
  assert.ok(cmdLines[0].length <= 162, `line length ${cmdLines[0].length}`);
  assert.ok(!h.split('\n').some((l) => /^\s*(with open|f\.write|")/.test(l)), 'script body leaked onto its own lines');
});
check('buildHandover lists files touched by terminal commands and the project folder', () => {
  const c = JSON.parse(JSON.stringify(brokenChat));
  c.data.chat.history.messages.a1.content_list.push({ phase: 'local_tool', extra: { local_mcp: { Terminal: [{ tool_name: 'run_command', params: {
    command: "python -c \"\npath = r'C:\\proj\\src\\curve.ts'\nopen(path,'w').write('y')\"" } }] } } });
  const h = G.buildHandover(c);
  assert.match(h, /curve\.ts/);
  assert.match(h, /Project folder: C:\\proj/);
});
check('buildHandover includes the original request when it exists', () => {
  const c = JSON.parse(JSON.stringify(brokenChat));
  c.data.chat.history.messages.u1 = { id: 'u1', role: 'user', content: 'Make the free kick curve more realistic' };
  assert.match(G.buildHandover(c), /Make the free kick curve more realistic/);
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
