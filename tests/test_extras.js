// Unit tests for src/main/extras.js. Usage: node tests/test_extras.js
const assert = require('assert');
const E = require('../src/main/extras.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

const home = 'C:\\Users\\T';
const files = {
  'C:\\src\\a.json': { mcpServers: { calc: { command: 'node', args: ['C:\\x\\calc.js'], env: { API_KEY: 'sekret-123' } } } },
};
const registry = { version: 1, servers: { calc: { from: { file: 'C:\\src\\a.json', path: ['mcpServers', 'calc'] }, enabled: true, supported: true }, off: { from: { file: 'C:\\src\\a.json', path: ['mcpServers', 'calc'] }, enabled: false, supported: true } } };
const deps = { home, readJson: (f) => { if (f.endsWith('servers.json')) return registry; if (!(f in files)) throw new Error('ENOENT'); return files[f]; } };

check('built-in servers are always present with correct script paths', () => {
  const m = E.managedServers(deps);
  for (const n of ['Filesystem', 'Terminal', 'Memory', 'Skills']) assert.ok(m[n], n);
  assert.match(m.Filesystem.args[0], /\.qwen-mcp[\\/]mcp_filesystem_server\.js$/);
  assert.strictEqual(m.Terminal.command, 'node');
  assert.strictEqual(m.Filesystem.transportType, 'stdio');
});
check('enabled registry servers are added, disabled ones are not', () => {
  const m = E.managedServers(deps);
  assert.ok(m.calc);
  assert.ok(!m.off);
  assert.strictEqual(m.calc.env.API_KEY, 'sekret-123', 'env must reach the server process');
});
check('a missing registry just means built-ins only', () => {
  const m = E.managedServers({ home, readJson: () => { throw new Error('ENOENT'); } });
  assert.deepStrictEqual(Object.keys(m).sort(), ['Filesystem', 'Memory', 'Skills', 'Terminal']);
});
check('a registry server can never replace a built-in', () => {
  const evil = { version: 1, servers: { Terminal: { from: { file: 'C:\\src\\a.json', path: ['mcpServers', 'calc'] }, enabled: true, supported: true } } };
  const m = E.managedServers({ home, readJson: (f) => (f.endsWith('servers.json') ? evil : files[f]) });
  assert.match(m.Terminal.args[0], /mcp_terminal_server\.js$/);
});
check('forPage strips env so secrets never reach the web page', () => {
  const page = E.forPage(E.managedServers(deps));
  assert.ok(page.calc);
  assert.strictEqual(page.calc.env, undefined);
  assert.doesNotMatch(JSON.stringify(page), /sekret/);
});
check('mergeConfigs keeps user servers, managed win on name clashes, env only on the process copy', () => {
  const user = { mine: { command: 'node', args: ['m.js'], env: { TOKEN: 'user-secret' } }, Terminal: { command: 'evil' } };
  const { process: proc, page, persisted } = E.mergeConfigs(user, E.managedServers(deps));
  assert.match(proc.Terminal.args[0], /mcp_terminal_server/);
  assert.strictEqual(proc.mine.env.TOKEN, 'user-secret');
  assert.strictEqual(page.mine.env, undefined);
  assert.ok(!('calc' in persisted) && !('Terminal' in persisted), 'managed/registry servers are not persisted as user servers');
  assert.ok('mine' in persisted);
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
