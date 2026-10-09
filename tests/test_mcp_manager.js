// Contract test for the Qwen main-process MCP manager.
// Usage: node test_mcp_manager.js <path-to-manager-module-or-"spark"> <app-node_modules-dir>
// The manager must expose: setMCPServers(cfg), getMCPServers(), listTools({serverName}),
// callTool({serverName, toolName, toolArguments}).
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const Module = require('module');

const [, , target, nodeModules] = process.argv;
process.env.NODE_PATH = nodeModules;
Module._initPaths();

const TERMINAL = path.join(__dirname, '..', 'servers', 'mcp_terminal_server.js');
const cfg = () => ({ T: { name: 'T', command: process.execPath, args: [TERMINAL], transportType: 'stdio' } });

const countServers = () => {
  const ps = `@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${process.pid} -and $_.CommandLine -like '*mcp_terminal_server*' }).Count`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  return Number(execSync(`powershell -NoProfile -EncodedCommand ${enc}`).toString().trim() || 0);
};
const pidOf = async (m) => {
  const r = await m.callTool({ serverName: 'T', toolName: 'run_command', toolArguments: { command: '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId' } });
  return r.content[0].text.trim();
};

(async () => {
  let manager;
  if (target === 'spark') {
    const sparkMcp = require('@ali/spark-mcp');
    manager = new sparkMcp.Proxy();
  } else {
    const { McpManager } = require(path.resolve(target));
    manager = new McpManager({ log: () => {} });
  }
  const origLog = console.log; console.log = () => {}; // silence noisy implementations
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
  };

  await manager.setMCPServers(cfg());
  await check('concurrent first calls spawn exactly one server', async () => {
    await Promise.all([1, 2, 3, 4].map(() => manager.listTools({ serverName: 'T' })));
    assert.strictEqual(countServers(), 1, `servers=${countServers()}`);
  });
  await check('re-setting an identical config keeps the same server process', async () => {
    const before = await pidOf(manager);
    await manager.setMCPServers(cfg());
    const after = await pidOf(manager);
    assert.strictEqual(after, before);
  });
  await check('changing config restarts that server without leaking the old process', async () => {
    const c = cfg(); c.T.args = [TERMINAL, '--v2'];
    await manager.setMCPServers(c);
    await manager.listTools({ serverName: 'T' });
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(countServers(), 1, `servers=${countServers()}`);
  });
  await check('tools/list is cached (second call < 5ms)', async () => {
    await manager.listTools({ serverName: 'T' });
    const t0 = process.hrtime.bigint();
    await manager.listTools({ serverName: 'T' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 5, `took ${ms.toFixed(1)}ms`);
  });
  await check('auto-reconnects after the server process dies', async () => {
    const pid = await pidOf(manager);
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    const r = await manager.callTool({ serverName: 'T', toolName: 'run_command', toolArguments: { command: 'Write-Output back' } });
    assert.match(r.content[0].text, /back/);
  });
  await check('tool results are capped before they reach the model', async () => {
    if (target === 'spark') throw new Error('stock proxy has no result cap');
    const r = await manager.callTool({ serverName: 'T', toolName: 'run_command', toolArguments: { command: "1..20000 | ForEach-Object { 'row' + $_ }" } });
    const t = r.content[0].text;
    assert.ok(t.length <= 21000, `length ${t.length}`);
    assert.match(t, /row20000/);
  });
  await check('removing a server closes its process', async () => {
    await manager.setMCPServers({});
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(countServers(), 0, `servers=${countServers()}`);
  });

  console.log = origLog;
  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
