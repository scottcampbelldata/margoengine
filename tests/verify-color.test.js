// Verify steps parse child stdout. Node colors console.log of a number or a boolean when FORCE_COLOR is set, which an
// agent shell does, so commandEnv forces color off and the text stays plain.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { commandEnv } from '../scripts/verify.mjs';

test('commandEnv turns color off even when the parent forces it, and a child log stays plain text', () => {
  const env = commandEnv({ ...process.env, FORCE_COLOR: '1', NO_COLOR: '' });
  assert.equal(env.FORCE_COLOR, '0');
  assert.equal(env.NO_COLOR, '1');
  const colored = spawnSync(process.execPath, ['-e', 'console.log(true); console.log(200);'], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  assert.match(colored.stdout, /\u001b\[/);
  const plain = spawnSync(process.execPath, ['-e', 'console.log(true); console.log(200);'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'true\n200\n');
});
