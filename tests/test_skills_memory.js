// Tests for the Skills and Memory MCP servers. Usage: node tests/test_skills_memory.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sm-'));
const skillsA = path.join(tmp, 'skillsA');
const skillsB = path.join(tmp, 'skillsB');
fs.mkdirSync(path.join(skillsA, 'debug-method', 'refs'), { recursive: true });
fs.writeFileSync(path.join(skillsA, 'debug-method', 'SKILL.md'), '---\nname: debug-method\ndescription: Use when a test fails or behaviour is unexpected.\n---\n# Debug\nReproduce first.\n');
fs.writeFileSync(path.join(skillsA, 'debug-method', 'refs', 'checklist.md'), 'CHECKLIST-BODY');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP-SECRET');
fs.mkdirSync(path.join(skillsB, 'no-frontmatter'), { recursive: true });
fs.writeFileSync(path.join(skillsB, 'no-frontmatter', 'SKILL.md'), '# Plain\n\nDoes plain things for the user.\n');
fs.mkdirSync(path.join(skillsB, 'big'), { recursive: true });
fs.writeFileSync(path.join(skillsB, 'big', 'SKILL.md'), '---\nname: big\ndescription: huge\n---\n' + 'x'.repeat(100000));

function client(script, env) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'servers', script)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
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
  let id = 1;
  const rpc = (method, params) => new Promise((res) => { const n = id++; waiters[n] = res; proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { err: !!r.result.isError, text: r.result.content[0].text }; };
  return { rpc, tool, kill: () => proc.kill() };
}

(async () => {
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

  const sk = client('mcp_skills_server.js', { QWEN_SKILLS_PATHS: `${skillsA};${skillsB}` });
  await check('skills: tools are listed with guidance to use them early', async () => {
    const r = await sk.rpc('tools/list', {});
    const names = r.result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['list_skills', 'load_skill', 'read_skill_file']);
    assert.match(r.result.tools.find((t) => t.name === 'list_skills').description, /before/i);
  });
  await check('skills: list shows name and description, frontmatter or not', async () => {
    const r = await sk.tool('list_skills');
    assert.match(r.text, /debug-method.*Use when a test fails/);
    assert.match(r.text, /no-frontmatter.*Does plain things/);
  });
  await check('skills: list can filter by keyword', async () => {
    const r = await sk.tool('list_skills', { query: 'test fails' });
    assert.match(r.text, /debug-method/);
    assert.doesNotMatch(r.text, /no-frontmatter/);
  });
  await check('skills: load returns the body and lists extra files', async () => {
    const r = await sk.tool('load_skill', { name: 'debug-method' });
    assert.match(r.text, /Reproduce first/);
    assert.match(r.text, /refs[\\/]checklist\.md/);
  });
  await check('skills: read_skill_file works inside the skill and refuses to escape it', async () => {
    assert.match((await sk.tool('read_skill_file', { name: 'debug-method', file: 'refs/checklist.md' })).text, /CHECKLIST-BODY/);
    const esc = await sk.tool('read_skill_file', { name: 'debug-method', file: '../../secret.txt' });
    assert.ok(esc.err);
    assert.doesNotMatch(esc.text, /TOP-SECRET/);
  });
  await check('skills: huge skills are capped; unknown skills give a hint', async () => {
    assert.ok((await sk.tool('load_skill', { name: 'big' })).text.length < 35000);
    const u = await sk.tool('load_skill', { name: 'nope' });
    assert.ok(u.err);
    assert.match(u.text, /list_skills/);
  });
  sk.kill();

  const memFile = path.join(tmp, 'memory.json');
  const mem = client('mcp_memory_server.js', { QWEN_MEMORY_FILE: memFile });
  await check('memory: remember, then recall by keyword', async () => {
    const r = await mem.tool('remember', { text: 'The fish_aquarium project uses Three.js and Vite', tags: ['fish', 'stack'] });
    assert.match(r.text, /mem-\d+/);
    await mem.tool('remember', { text: 'User prefers PowerShell over bash' });
    const q = await mem.tool('recall', { query: 'three.js vite' });
    assert.match(q.text, /fish_aquarium/);
    assert.doesNotMatch(q.text, /PowerShell/);
  });
  await check('memory: recall without a query returns the newest first', async () => {
    const q = await mem.tool('recall', {});
    assert.ok(q.text.indexOf('PowerShell') < q.text.indexOf('fish_aquarium'));
  });
  await check('memory: persists to disk and survives a restart', async () => {
    mem.kill();
    const again = client('mcp_memory_server.js', { QWEN_MEMORY_FILE: memFile });
    assert.match((await again.tool('recall', { query: 'powershell' })).text, /PowerShell/);
    globalThis.__again = again;
  });
  await check('memory: forget removes an entry; bad ids are clear errors', async () => {
    const again = globalThis.__again;
    const id = (await again.tool('recall', { query: 'powershell' })).text.match(/mem-\d+/)[0];
    assert.match((await again.tool('forget', { id })).text, /forgot/i);
    assert.match((await again.tool('recall', { query: 'powershell' })).text, /no memories/i);
    const bad = await again.tool('forget', { id: 'mem-999999' });
    assert.ok(bad.err);
  });
  await check('memory: oversized text is rejected, empty text too', async () => {
    const again = globalThis.__again;
    assert.ok((await again.tool('remember', { text: 'x'.repeat(5000) })).err);
    assert.ok((await again.tool('remember', { text: '   ' })).err);
    again.kill();
  });

  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
