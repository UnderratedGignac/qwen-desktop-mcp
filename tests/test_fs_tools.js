const { McpManager } = require('../src/main/mcp-manager.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(require('os').tmpdir(), 'qwen-mcp-fs-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'sub', 'deep'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'a.txt'), 'hello world\nsecond line\nthird line\n');
fs.writeFileSync(path.join(ROOT, 'sub', 'b.md'), '# title\nfindme token here\n');
fs.writeFileSync(path.join(ROOT, 'sub', 'deep', 'c.json'), '{"x":1}');
fs.writeFileSync(path.join(ROOT, 'big.bin'), Buffer.alloc(2048, 7));

const p = new McpManager({ log: () => {} });

async function call(tool, args) {
  const r = await p.callTool({ serverName: 'FS', toolName: tool, toolArguments: args });
  return r;
}

const results = [];
function check(name, cond, detail) {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + String(detail).slice(0, 120).replace(/\n/g, '\\n') : ''}`);
}

(async () => {
  await p.setMCPServers({ FS: { name: 'FS', command: 'node', args: [path.join(__dirname, '..', 'servers', 'mcp_filesystem_server.js'), ROOT], transportType: 'stdio' } });
  const tools = await p.listTools({ serverName: 'FS' });
  check('tools/list returns 14', tools.tools.length === 14, tools.tools.map(t => t.name).join(','));

  let r = await call('list_allowed_directories', {});
  check('list_allowed_directories', r.content[0].text.includes(ROOT), r.content[0].text);

  r = await call('list_directory', { path: ROOT });
  check('list_directory', r.content[0].text.includes('[DIR] sub') && r.content[0].text.includes('[FILE] a.txt'), r.content[0].text);

  r = await call('list_directory_with_sizes', { path: ROOT, sortBy: 'size' });
  check('list_directory_with_sizes', /Total:.*bytes/.test(r.content[0].text) && r.content[0].text.includes('big.bin (2.0 KB)'), r.content[0].text);

  r = await call('read_text_file', { path: path.join(ROOT, 'a.txt') });
  check('read_text_file full', r.content[0].text === 'hello world\nsecond line\nthird line\n');

  r = await call('read_file', { path: path.join(ROOT, 'a.txt'), head: 2 });
  check('read_file head=2', r.content[0].text === 'hello world\nsecond line', r.content[0].text);

  r = await call('read_file', { path: path.join(ROOT, 'a.txt'), tail: 1 });
  check('read_file tail=1', r.content[0].text.trim() === 'third line', r.content[0].text);

  r = await call('read_multiple_files', { paths: [path.join(ROOT, 'a.txt'), path.join(ROOT, 'sub', 'b.md')] });
  check('read_multiple_files', r.content.length === 2 && r.content[0].text.includes('hello world') && r.content[1].text.includes('# title'));

  r = await call('write_file', { path: path.join(ROOT, 'out', 'new.txt'), content: 'created by mcp' });
  check('write_file (auto-mkdir)', fs.readFileSync(path.join(ROOT, 'out', 'new.txt'), 'utf8') === 'created by mcp');

  r = await call('edit_file', { path: path.join(ROOT, 'out', 'new.txt'), edits: [{ oldText: 'mcp', newText: 'MCP!' }] });
  check('edit_file', fs.readFileSync(path.join(ROOT, 'out', 'new.txt'), 'utf8') === 'created by MCP!');

  r = await call('edit_file', { path: path.join(ROOT, 'out', 'new.txt'), edits: [{ oldText: 'MCP!', newText: 'zzz' }], dryRun: true });
  check('edit_file dryRun (no write)', fs.readFileSync(path.join(ROOT, 'out', 'new.txt'), 'utf8') === 'created by MCP!' && r.content[0].text.includes('DRY RUN'));

  r = await call('create_directory', { path: path.join(ROOT, 'emptydir') });
  check('create_directory', fs.existsSync(path.join(ROOT, 'emptydir')) && fs.statSync(path.join(ROOT, 'emptydir')).isDirectory());

  r = await call('move_file', { source: path.join(ROOT, 'out', 'new.txt'), destination: path.join(ROOT, 'moved.txt') });
  check('move_file', !fs.existsSync(path.join(ROOT, 'out', 'new.txt')) && fs.existsSync(path.join(ROOT, 'moved.txt')));

  r = await call('search_files', { path: ROOT, pattern: '*.md' });
  check('search_files *.md', r.content[0].text.includes('b.md'), r.content[0].text);

  r = await call('search_files', { path: ROOT, pattern: '**/c.json' });
  check('search_files **/c.json', r.content[0].text.includes('c.json'), r.content[0].text);

  r = await call('directory_tree', { path: ROOT });
  const tree = JSON.parse(r.content[0].text);
  check('directory_tree', Array.isArray(tree) && tree.some(e => e.name === 'sub' && e.type === 'directory') && tree.some(e => e.name === 'a.txt'));

  r = await call('get_file_info', { path: path.join(ROOT, 'big.bin') });
  check('get_file_info', r.content[0].text.includes('size: 2048') && r.content[0].text.includes('isFile: true'));

  // base64 round-trip via write_file + read_media_file
  const b64 = fs.readFileSync(path.join(ROOT, 'big.bin')).toString('base64');
  r = await call('write_file', { path: path.join(ROOT, 'copy.bin'), content: b64, binary: 'base64' });
  check('write_file base64', fs.readFileSync(path.join(ROOT, 'copy.bin')).equals(fs.readFileSync(path.join(ROOT, 'big.bin'))));

  // PNG for read_media_file
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(ROOT, 'p.png'), png);
  r = await call('read_media_file', { path: path.join(ROOT, 'p.png') });
  check('read_media_file png', r.content[0].type === 'image' && r.content[0].mimeType === 'image/png' && r.content[0].data === png.toString('base64'));

  // security: outside allowed dirs
  r = await call('list_directory', { path: 'C:\\Windows\\System32' });
  check('path escape blocked', r.isError === true || String(r.content[0].text).includes('Access denied') || String(r.content[0].text).includes('Error'), r.content[0].text);

  console.log(results.join('\n'));
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log(`\n=== ${results.length - fails}/${results.length} PASSED ===`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH:', String(e && e.message || e).slice(0, 400)); process.exit(1); });
