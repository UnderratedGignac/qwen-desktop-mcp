// Unit tests for src/main/registry.js. Usage: node tests/test_registry.js
const assert = require('assert');
const R = require('../src/main/registry.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

const files = {
  'C:\\u\\.claude.json': {
    mcpServers: {
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'] },
      'elie-oracle': { command: 'python', args: ['C:\\x\\oracle.py'], env: { ORACLE_PASSWORD: 'hunter2-SECRET', ORACLE_DSN: 'db' } },
      calc: { command: 'node', args: ['C:\\x\\calc.js'] },
    },
    projects: { 'C:/p': { mcpServers: { calc: { command: 'node', args: ['C:\\x\\calc.js'] }, memo: { command: 'node', args: ['C:\\x\\memo.js'] } } } },
  },
  'C:\\p\\.mcp.json': { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] }, remote: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer abc' } } },
  'C:\\p\\plugin\\.mcp.json': { mcpServers: { local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } } },
};
const sources = Object.keys(files).map((file) => ({ file, json: files[file] }));

check('discovers servers from mcpServers, project scopes and bare plugin maps', () => {
  const names = R.discoverServers(sources).map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['calc', 'chrome-devtools', 'elie-oracle', 'local', 'memo', 'playwright', 'remote']);
});
check('duplicates keep the first source', () => {
  const calc = R.discoverServers(sources).filter((s) => s.name === 'calc');
  assert.strictEqual(calc.length, 1);
  assert.deepStrictEqual(calc[0].from.path, ['mcpServers', 'calc']);
});
check('discovery output never contains env values or header values', () => {
  const dump = JSON.stringify(R.discoverServers(sources));
  assert.doesNotMatch(dump, /hunter2|SECRET|Bearer|abc/);
  const oracle = R.discoverServers(sources).find((s) => s.name === 'elie-oracle');
  assert.deepStrictEqual(oracle.envKeys.sort(), ['ORACLE_DSN', 'ORACLE_PASSWORD']);
});
check('risk: secrets in env, database, real-browser attach and remote auth are high', () => {
  const by = Object.fromEntries(R.discoverServers(sources).map((s) => [s.name, s]));
  assert.strictEqual(by['elie-oracle'].risk, 'high');
  assert.strictEqual(by['chrome-devtools'].risk, 'high'); // --autoConnect attaches to the user's own Chrome
  assert.strictEqual(by.remote.risk, 'high');
  assert.strictEqual(by.calc.risk, 'low');
  assert.ok(by['elie-oracle'].reasons.length > 0);
});
check('risk: a self-launched browser is medium', () => {
  const by = Object.fromEntries(R.discoverServers(sources).map((s) => [s.name, s]));
  assert.strictEqual(by.playwright.risk, 'medium');
});
check('risk: a path that merely contains "Desktop" is not desktop control', () => {
  const f = R.discoverServers([{ file: 'f', json: { mcpServers: { tool: { command: 'C:\\Users\\E\\Desktop\\bin\\py.exe', args: ['C:\\Users\\E\\Desktop\\x\\server.py'] }, 'windows-mcp': { command: 'uvx', args: ['windows-mcp'] } } } }]);
  assert.strictEqual(f.find((s) => s.name === 'tool').risk, 'low');
  assert.strictEqual(f.find((s) => s.name === 'windows-mcp').risk, 'high');
});
check('syncRegistry registers everything disabled (the user opts in) and keeps their choices', () => {
  const found = R.discoverServers(sources);
  let reg = R.syncRegistry({ version: 1, servers: {} }, found);
  for (const e of Object.values(reg.servers)) assert.strictEqual(e.enabled, false);
  reg.servers.calc.enabled = true; // user decision
  reg.servers['elie-oracle'].enabled = true;
  reg.servers.memo.enabled = false;
  reg = R.syncRegistry(reg, found);
  assert.strictEqual(reg.servers.calc.enabled, true);
  assert.strictEqual(reg.servers['elie-oracle'].enabled, true);
  assert.strictEqual(reg.servers.memo.enabled, false);
});
check('syncRegistry marks servers whose source vanished', () => {
  const reg = R.syncRegistry({ version: 1, servers: {} }, R.discoverServers(sources));
  const next = R.syncRegistry(reg, R.discoverServers(sources.slice(0, 1)));
  assert.strictEqual(next.servers.playwright.missing, true);
  assert.strictEqual(next.servers.calc.missing, undefined);
});
check('built-in server names are never taken by discovered servers', () => {
  const found = R.discoverServers([{ file: 'f', json: { mcpServers: { Filesystem: { command: 'x' }, terminal: { command: 'y' }, ok: { command: 'z' } } } }]);
  assert.deepStrictEqual(found.map((s) => s.name), ['ok']);
});

const readJson = (f) => files[f];
check('resolveEnabled returns live configs read from the source file, env included', () => {
  const reg = R.syncRegistry({ version: 1, servers: {} }, R.discoverServers(sources));
  for (const n of ['calc', 'memo', 'local', 'elie-oracle']) reg.servers[n].enabled = true;
  const cfg = R.resolveEnabled(reg, readJson);
  assert.deepStrictEqual(Object.keys(cfg).sort(), ['calc', 'elie-oracle', 'local', 'memo'].sort());
  assert.strictEqual(cfg['elie-oracle'].env.ORACLE_PASSWORD, 'hunter2-SECRET');
  assert.strictEqual(cfg.calc.transportType, 'stdio');
  assert.deepStrictEqual(cfg.calc.args, ['C:\\x\\calc.js']);
});
check('${CLAUDE_PLUGIN_ROOT} resolves to the plugin folder', () => {
  const reg = R.syncRegistry({ version: 1, servers: {} }, R.discoverServers(sources));
  reg.servers.local.enabled = true;
  const cfg = R.resolveEnabled(reg, readJson);
  assert.match(cfg.local.args[0], /^C:\\p\\plugin[\\/]server\.js$/);
});
check('unreadable sources and unsupported transports are skipped, not fatal', () => {
  const reg = R.syncRegistry({ version: 1, servers: {} }, R.discoverServers(sources));
  for (const n of ['remote', 'calc', 'local']) reg.servers[n].enabled = true; // remote has headers: unsupported
  const cfg = R.resolveEnabled(reg, (f) => { if (f.endsWith('.claude.json')) throw new Error('gone'); return files[f]; });
  assert.ok(!cfg.remote);
  assert.ok(!cfg.calc);
  assert.ok(cfg.local);
});
check('estimateTools is a cheap token hint', () => {
  assert.strictEqual(R.TOKENS_PER_TOOL > 50, true);
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
