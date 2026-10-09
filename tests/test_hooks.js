// Unit tests for src/main/hooks.js. Usage: node tests/test_hooks.js
const assert = require('assert');
const H = require('../src/main/hooks.js');

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

(async () => {
  await check('only whitelisted events are accepted from the page', () => {
    assert.ok(H.EVENTS.includes('turn_finished'));
    assert.strictEqual(H.sanitizeEvent({ type: 'qwen-hook', event: 'turn_finished', chatId: 'c1' }).event, 'turn_finished');
    assert.strictEqual(H.sanitizeEvent({ type: 'qwen-hook', event: 'rm -rf /' }), null);
    assert.strictEqual(H.sanitizeEvent({ type: 'other', event: 'turn_finished' }), null);
    assert.strictEqual(H.sanitizeEvent(null), null);
  });
  await check('sanitize bounds and strips every payload field', () => {
    const e = H.sanitizeEvent({ type: 'qwen-hook', event: 'turn_failed', chatId: 'x'.repeat(500), title: 'a\nb"; calc.exe', durationMs: '12', toolsRan: 3, command: 'calc.exe' });
    assert.ok(e.chatId.length <= 64);
    assert.doesNotMatch(e.title, /[\r\n]/);
    assert.strictEqual(e.durationMs, 12);
    assert.strictEqual(e.toolsRan, 3);
    assert.strictEqual(e.command, undefined, 'unknown fields are dropped');
  });
  await check('default config notifies on finish and failure only', () => {
    const c = H.defaultConfig();
    assert.ok(c.hooks.turn_finished.some((h) => h.type === 'notify'));
    assert.ok(c.hooks.turn_failed.some((h) => h.type === 'notify'));
    assert.ok(!c.hooks.turn_started);
  });
  await check('parseConfig tolerates junk and merges over defaults', () => {
    assert.deepStrictEqual(H.parseConfig('not json').hooks, H.defaultConfig().hooks);
    const c = H.parseConfig(JSON.stringify({ hooks: { turn_finished: [{ type: 'command', command: 'echo hi' }, { type: 'bogus' }] } }));
    assert.deepStrictEqual(c.hooks.turn_finished, [{ type: 'command', command: 'echo hi' }]);
    assert.ok(c.hooks.turn_failed, 'unspecified events keep defaults');
  });
  await check('runHooks runs commands with event data in env and stdin, never in the command line', async () => {
    const calls = [];
    const deps = { spawn: (cmd, env, stdin) => calls.push({ cmd, env, stdin }), notify: () => {}, isFocused: () => true, profile: 'Work' };
    const cfg = { hooks: { turn_finished: [{ type: 'command', command: 'powershell -File done.ps1' }] } };
    const ev = H.sanitizeEvent({ type: 'qwen-hook', event: 'turn_finished', chatId: 'abc', title: 'Fix "it"; calc', durationMs: 5000, toolsRan: 2 });
    await H.runHooks(ev, cfg, deps);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, 'powershell -File done.ps1');
    assert.strictEqual(calls[0].env.QWEN_EVENT, 'turn_finished');
    assert.strictEqual(calls[0].env.QWEN_CHAT_ID, 'abc');
    assert.strictEqual(calls[0].env.QWEN_PROFILE, 'Work');
    assert.strictEqual(calls[0].env.QWEN_TOOLS_RAN, '2');
    assert.doesNotMatch(calls[0].cmd, /calc/);
    assert.strictEqual(JSON.parse(calls[0].stdin).title, 'Fix "it"; calc');
  });
  await check('notify hook is skipped while the window is focused unless always=true', async () => {
    const shown = [];
    const mk = (focused) => ({ spawn: () => {}, notify: (n) => shown.push(n), isFocused: () => focused, profile: null });
    const cfg = { hooks: { turn_finished: [{ type: 'notify' }] } };
    const ev = H.sanitizeEvent({ type: 'qwen-hook', event: 'turn_finished', title: 'Task', durationMs: 65000, toolsRan: 4 });
    await H.runHooks(ev, cfg, mk(true));
    assert.strictEqual(shown.length, 0);
    await H.runHooks(ev, cfg, mk(false));
    assert.strictEqual(shown.length, 1);
    assert.match(shown[0].title, /finished/i);
    assert.match(shown[0].body, /1m 5s|65s|1 min/);
    await H.runHooks(ev, { hooks: { turn_finished: [{ type: 'notify', always: true }] } }, mk(true));
    assert.strictEqual(shown.length, 2);
  });
  await check('a failing hook never stops the others', async () => {
    const ran = [];
    const deps = { spawn: (cmd) => { if (cmd === 'bad') throw new Error('boom'); ran.push(cmd); }, notify: () => {}, isFocused: () => false, profile: null };
    const cfg = { hooks: { turn_finished: [{ type: 'command', command: 'bad' }, { type: 'command', command: 'good' }] } };
    await H.runHooks(H.sanitizeEvent({ type: 'qwen-hook', event: 'turn_finished' }), cfg, deps);
    assert.deepStrictEqual(ran, ['good']);
  });
  await check('formatDuration', () => {
    assert.strictEqual(H.formatDuration(4000), '4s');
    assert.strictEqual(H.formatDuration(65000), '1m 5s');
    assert.strictEqual(H.formatDuration(3700000), '1h 1m');
  });

  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
