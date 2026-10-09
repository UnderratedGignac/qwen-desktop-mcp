// Contract test for the Terminal MCP server. Usage: node test_terminal_server.js <server.js>
const { spawn } = require('child_process');
const assert = require('assert');

const serverPath = process.argv[2] || require('path').join(__dirname, '..', 'servers', 'mcp_terminal_server.js');
const proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = {};
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (waiters[msg.id]) waiters[msg.id](msg);
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++;
  waiters[id] = res;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const run = (args) => rpc('tools/call', { name: 'run_command', arguments: args });
const text = (r) => r.result.content.map((c) => c.text).join('');

(async () => {
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
  };

  await check('initialize', async () => {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.strictEqual(r.result.serverInfo.name, 'Terminal');
  });
  await check('tools/list exposes run_command', async () => {
    const r = await rpc('tools/list', {});
    assert.ok(r.result.tools.some((t) => t.name === 'run_command'));
  });
  await check('runs a command and returns stdout', async () => {
    const r = await run({ command: 'Write-Output hello-mcp' });
    assert.match(text(r), /hello-mcp/);
    assert.ok(!r.result.isError);
  });
  await check('fast: simple command under 900ms (no profile load)', async () => {
    const t0 = Date.now();
    await run({ command: 'Write-Output 1' });
    const ms = Date.now() - t0;
    assert.ok(ms < 900, `took ${ms}ms`);
  });
  await check('non-zero exit is reported as error with exit code', async () => {
    const r = await run({ command: 'exit 3' });
    assert.ok(r.result.isError);
    assert.match(text(r), /exit code 3/i);
  });
  await check('UTF-8 output survives', async () => {
    const r = await run({ command: "Write-Output 'café ✓ مرحبا'" });
    assert.match(text(r), /café ✓ مرحبا/);
  });
  await check('timeout kills the command and returns promptly', async () => {
    const t0 = Date.now();
    const r = await run({ command: 'Start-Sleep -Seconds 20; Write-Output never', timeout: 1500 });
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `took ${ms}ms`);
    assert.ok(r.result.isError);
    assert.match(text(r), /timed out/i);
    assert.doesNotMatch(text(r), /never/);
  });
  await check('huge output is truncated to keep the model context small', async () => {
    const r = await run({ command: "1..200000 | ForEach-Object { 'line' + $_ }" });
    const t = text(r);
    assert.ok(t.length < 70000, `length ${t.length}`);
    assert.match(t, /truncated/i);
    assert.match(t, /line200000/); // tail is kept
  });
  await check('cmd shell is supported', async () => {
    const r = await run({ command: 'echo cmd-ok', shell: 'cmd' });
    assert.match(text(r), /cmd-ok/);
  });

  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  proc.kill();
  process.exit(failed ? 1 : 0);
})();
