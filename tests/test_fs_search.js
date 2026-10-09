// Tests for the search_content tool of the Filesystem server. Usage: node tests/test_fs_search.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-fs-search-'));
fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const x = 1;\nfunction drawFish() {}\n// TODO: speed up drawFish\n');
fs.writeFileSync(path.join(root, 'src', 'deep', 'b.ts'), 'export const DRAWFISH = 2;\nnothing here\n');
fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'c.js'), 'function drawFish() { /* vendored */ }\n');
fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 100, 114, 97, 119, 70, 105, 115, 104, 0]));
fs.writeFileSync(path.join(root, 'big.txt'), 'bigtoken\n'.repeat(500));

const proc = spawn(process.execPath, [path.join(__dirname, '..', 'servers', 'mcp_filesystem_server.js'), root], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = {};
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { const m = JSON.parse(line); if (waiters[m.id]) waiters[m.id](m); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res) => { const id = nextId++; waiters[id] = res; proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const search = (args) => rpc('tools/call', { name: 'search_content', arguments: { path: root, ...args } }).then((r) => ({ err: r.result.isError, text: r.result.content[0].text }));

(async () => {
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

  await check('tool is listed with a schema', async () => {
    const r = await rpc('tools/list', {});
    const t = r.result.tools.find((x) => x.name === 'search_content');
    assert.ok(t && t.inputSchema.required.includes('pattern'));
  });
  await check('finds matches with file:line and skips node_modules by default', async () => {
    const r = await search({ pattern: 'drawFish' });
    assert.ok(!r.err, r.text);
    assert.match(r.text, /src[\\/]a\.js:2:/);
    assert.match(r.text, /src[\\/]a\.js:3:/);
    assert.doesNotMatch(r.text, /node_modules/);
  });
  await check('case-insensitive flag', async () => {
    const r = await search({ pattern: 'drawfish', ignoreCase: true });
    assert.match(r.text, /b\.ts:1:/);
    const strict = await search({ pattern: 'drawfish' });
    assert.doesNotMatch(strict.text, /b\.ts/);
  });
  await check('glob limits files; regex works', async () => {
    const r = await search({ pattern: 'const \\w+ = \\d', glob: '**/*.ts' });
    assert.match(r.text, /b\.ts/);
    assert.doesNotMatch(r.text, /a\.js/);
  });
  await check('binary files are skipped', async () => {
    const r = await search({ pattern: 'rawFish' });
    assert.doesNotMatch(r.text, /bin\.dat/);
  });
  await check('results are capped and say so', async () => {
    const r = await search({ pattern: 'bigtoken', glob: 'big.txt', maxResults: 20 });
    assert.strictEqual(r.text.split('\n').filter((l) => /big\.txt:\d+:/.test(l)).length, 20);
    assert.match(r.text, /more matches|truncated/i);
  });
  await check('context lines', async () => {
    const r = await search({ pattern: 'TODO', context: 1 });
    assert.match(r.text, /function drawFish/);
  });
  await check('no matches and bad regex are clear', async () => {
    assert.match((await search({ pattern: 'zzz-not-here' })).text, /no matches/i);
    const bad = await search({ pattern: '(' });
    assert.ok(bad.err);
    assert.match(bad.text, /regex/i);
  });
  await check('outside allowed directories is refused', async () => {
    const r = await rpc('tools/call', { name: 'search_content', arguments: { path: 'C:\\Windows', pattern: 'x' } });
    assert.ok(r.result.isError);
  });

  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  proc.kill();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
