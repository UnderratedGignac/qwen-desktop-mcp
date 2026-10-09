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
  await check('fast: simple command under 2.5s (no profile load)', async () => {
    const t0 = Date.now();
    await run({ command: 'Write-Output 1' });
    const ms = Date.now() - t0;
    assert.ok(ms < 2500, `took ${ms}ms`);
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
    const r = await run({ command: "1..50000 | ForEach-Object { 'line' + $_ }" });
    const t = text(r);
    assert.ok(t.length < 70000, `length ${t.length}`);
    assert.match(t, /truncated/i);
    assert.match(t, /line50000/); // tail is kept
  });
  await check('cmd shell is supported', async () => {
    const r = await run({ command: 'echo cmd-ok', shell: 'cmd' });
    assert.match(text(r), /cmd-ok/);
  });

  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const parse = (r) => JSON.parse(text(r));

  await check('background jobs: start returns immediately with an id', async () => {
    const t0 = Date.now();
    const r = await call('start_job', { command: "1..4 | ForEach-Object { Write-Output \"tick$_\"; Start-Sleep -Milliseconds 400 }" });
    assert.ok(Date.now() - t0 < 1500, `start took ${Date.now() - t0}ms`);
    const j = parse(r);
    assert.match(j.job_id, /^job-\d+$/);
    assert.strictEqual(j.status, 'running');
    globalThis.__jobId = j.job_id;
  });
  await check('background jobs: job_output streams new output and reports completion', async () => {
    const id = globalThis.__jobId;
    let r = parse(await call('job_output', { job_id: id, wait_ms: 700 }));
    assert.strictEqual(r.status, 'running');
    assert.match(r.output, /tick1/);
    r = parse(await call('job_output', { job_id: id, wait_ms: 5000, until_done: true }));
    assert.strictEqual(r.status, 'finished');
    assert.strictEqual(r.exit_code, 0);
    assert.match(r.output, /tick4/);
    assert.doesNotMatch(r.output, /tick1/, 'already-read output is not repeated');
  });
  await check('background jobs: a long job can be stopped and its process tree dies', async () => {
    const j = parse(await call('start_job', { command: 'Start-Sleep -Seconds 60; Write-Output never' }));
    const s = parse(await call('job_stop', { job_id: j.job_id }));
    assert.strictEqual(s.status, 'stopped');
    const r = parse(await call('job_output', { job_id: j.job_id }));
    assert.strictEqual(r.status, 'stopped');
  });
  await check('background jobs: list_jobs shows jobs; unknown id is a clear error', async () => {
    const l = parse(await call('list_jobs', {}));
    assert.ok(l.jobs.length >= 2);
    const r = await call('job_output', { job_id: 'job-999' });
    assert.ok(r.result.isError);
    assert.match(text(r), /unknown job/i);
  });
  await check('background jobs: a job outlives the default foreground timeout', async () => {
    const j = parse(await call('start_job', { command: 'Start-Sleep -Seconds 3; Write-Output slow-done' }));
    const r = parse(await call('job_output', { job_id: j.job_id, wait_ms: 8000, until_done: true }));
    assert.strictEqual(r.status, 'finished');
    assert.match(r.output, /slow-done/);
  });

  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  proc.kill();
  process.exit(failed ? 1 : 0);
})();
