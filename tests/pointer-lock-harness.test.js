// scripts/support/pointer-lock.mjs: which native pointer lock refusals a browser check may note instead of fail.
// Regression for the M6 Mac mini (2026-11-10): Chromium refused requestPointerLock with WrongDocumentError on a locked
// console, which failed packages/input/test/input-browser.mjs and packages/worker/tests/browser-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { macConsoleSession, pointerLockRefusalReason } from '../scripts/support/pointer-lock.mjs';

const refused = 'WrongDocumentError: The root document of this element is not valid for pointer lock.';

test('a locked macOS console is a documented reason', () => {
  const reason = pointerLockRefusalReason({
    platform: 'darwin',
    error: refused,
    session: { screenLocked: true, frontBundle: 'com.apple.loginwindow' },
  });
  assert.match(reason, /console is locked .*com\.apple\.loginwindow/);
});

test('another app in front on macOS is a documented reason; the browser in front is not', () => {
  assert.match(
    pointerLockRefusalReason({
      platform: 'darwin',
      error: refused,
      session: { screenLocked: false, frontBundle: 'com.apple.Terminal' },
    }),
    /front app is com\.apple\.Terminal/,
  );
  for (const frontBundle of ['com.google.chrome.for.testing', 'org.chromium.Chromium', 'com.google.Chrome'])
    assert.equal(
      pointerLockRefusalReason({ platform: 'darwin', error: refused, session: { screenLocked: false, frontBundle } }),
      null,
    );
});

test('every other refusal fails the check', () => {
  const locked = { screenLocked: true, frontBundle: 'com.apple.loginwindow' };
  for (const platform of ['win32', 'linux'])
    assert.equal(pointerLockRefusalReason({ platform, error: refused, session: locked }), null);
  assert.equal(pointerLockRefusalReason({ platform: 'darwin', error: 'NotAllowedError: x', session: locked }), null);
  assert.equal(pointerLockRefusalReason({ platform: 'darwin', error: refused, session: null }), null);
});

test('the macOS session is read from ioreg and lsappinfo', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'ioreg') return '<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>';
    if (args[0] === 'front') return 'ASN:0x0-0x2d02d:\n';
    return '[ NULL ]  ASN:0x0-0x2d02d: (in front)\n    bundleID="com.apple.loginwindow"\n';
  };
  assert.deepEqual(macConsoleSession({ platform: 'darwin', run }), {
    screenLocked: true,
    frontBundle: 'com.apple.loginwindow',
  });
  assert.equal(calls[2], 'lsappinfo info -only bundleid ASN:0x0-0x2d02d');
  assert.equal(macConsoleSession({ platform: 'linux', run }), null);
  assert.deepEqual(
    macConsoleSession({ platform: 'darwin', run: (c, a) => (c === 'ioreg' ? '' : run(c, a)) }).screenLocked,
    false,
  );
});
