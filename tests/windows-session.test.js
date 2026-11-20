import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTasklistSession, windowsSession } from '../scripts/support/windows-session.mjs';

// tasklist /FO CSV /NH lines as measured on the dev PC (2026-11-15): over SSH node ran in session 0 ("Services"), from
// the signed-in desktop in session 1 (an empty session name there).
test('a tasklist line gives the session id and name', () => {
  assert.deepEqual(parseTasklistSession('"node.exe","38112","Services","0","70,600 K"'), { id: 0, name: 'Services' });
  assert.deepEqual(parseTasklistSession('"node.exe","81572","","1","71,940 K"'), { id: 1, name: '' });
  assert.equal(parseTasklistSession('INFO: No tasks are running which match the specified criteria.'), null);
});

test('the session is looked up on Windows only, and an unreadable answer is no session', () => {
  let calls = 0;
  const run = () => {
    calls++;
    return { status: 0, stdout: '"node.exe","1","Services","0","1 K"\r\n' };
  };
  assert.equal(windowsSession(1, { platform: 'linux', run }), null);
  assert.equal(calls, 0);
  assert.deepEqual(windowsSession(1, { platform: 'win32', run }), { id: 0, name: 'Services' });
  assert.equal(windowsSession(1, { platform: 'win32', run: () => ({ status: 1, stdout: '' }) }), null);
});
