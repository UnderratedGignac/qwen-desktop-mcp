// Unit tests for src/main/profile.js. Usage: node tests/test_profile.js
const assert = require('assert');
const { profileName, windowTitle } = require('../src/main/profile.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

check('explicit --qwen-profile wins', () => {
  assert.strictEqual(profileName(['Qwen.exe', '--qwen-profile=Work'], 'C:\\x'), 'Work');
  assert.strictEqual(profileName(['Qwen.exe', '--qwen-profile="Account 2"'], 'C:\\x'), 'Account 2');
});
check('falls back to the Qwen-profiles folder name', () => {
  assert.strictEqual(profileName(['Qwen.exe'], 'C:\\Users\\E\\AppData\\Roaming\\Qwen-profiles\\account3'), 'account3');
});
check('default profile has no name', () => {
  assert.strictEqual(profileName(['Qwen.exe'], 'C:\\Users\\E\\AppData\\Roaming\\Qwen'), null);
});
check('window title shows the account only when named', () => {
  assert.strictEqual(windowTitle('Qwen', 'Work'), 'Qwen — Work');
  assert.strictEqual(windowTitle('Qwen', null), 'Qwen');
  assert.strictEqual(windowTitle('Qwen — Work', 'Work'), 'Qwen — Work', 'no double suffix');
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
