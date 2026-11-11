import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  channelExecutable,
  chromiumExecutablePath,
  chromiumLaunchOptions,
  installedVersionExecutable,
  launchBrowser,
  peFileVersion,
  resolveBrowser,
} from '../scripts/lib/browser.mjs';

// KB-C34i (2026-11-11): an Edge auto-update renamed its pending new_msedge.exe over Application\msedge.exe while a GPU
// suite was starting Edge from that top-level file; the browser lost its GPU process and the page got no WebGPU adapter.
// Started from Application\<installed version>\msedge.exe it survives the swap, so test launches start it from there.

/** A stand-in Windows executable: a decoy "VS_VERSION_INFO" text, then a real VS_VERSIONINFO block with `version`. */
function fakeExe(version) {
  const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le'),
    [a, b, c, d] = version.split('.').map(Number);
  const block = Buffer.alloc(40 + 52);
  block.writeUInt16LE(block.length, 0);
  block.writeUInt16LE(52, 2);
  key.copy(block, 6);
  block.writeUInt32LE(0xfeef04bd, 40);
  block.writeUInt32LE(0x00010000, 44);
  block.writeUInt32LE(((a << 16) | b) >>> 0, 48);
  block.writeUInt32LE(((c << 16) | d) >>> 0, 52);
  // The decoy key sits where no signature follows it (a string in the code section of a real msedge.exe).
  return Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62), key, Buffer.alloc(100), block, Buffer.alloc(16)]);
}

/** A fake install under a temporary LOCALAPPDATA: `files` maps a path under the Application folder to its version. */
function install(product, exe, files) {
  const root = mkdtempSync(join(tmpdir(), 'kbc34i-')),
    app = join(root, ...product, 'Application');
  for (const [path, version] of Object.entries(files)) {
    mkdirSync(join(app, path, '..'), { recursive: true });
    if (version === 'dir') mkdirSync(join(app, path), { recursive: true });
    else writeFileSync(join(app, path), version ? fakeExe(version) : Buffer.from('not an executable'));
  }
  return { root, app: (...parts) => win32.join(root, ...product, 'Application', ...parts), exe, done: () => rmSync(root, { recursive: true, force: true }) };
}
const edge = (files) => install(['Microsoft', 'Edge'], 'msedge.exe', files);

test('the file version is read from the version resource, not from a stray copy of its key', () => {
  assert.equal(peFileVersion(fakeExe('157.0.4341.42')), '157.0.4341.42');
  assert.equal(peFileVersion(fakeExe('65535.1.65535.0')), '65535.1.65535.0');
  assert.equal(peFileVersion(Buffer.from('no version here')), undefined);
});

test('mid-update (two version folders, a pending new_msedge.exe): Edge starts from the version the top-level exe is', async () => {
  const fake = edge({
    'msedge.exe': '157.0.4341.42',
    'new_msedge.exe': '157.0.4341.46',
    '157.0.4341.42/msedge.exe': '157.0.4341.42',
    '157.0.4341.46/msedge.exe': '157.0.4341.46',
  });
  try {
    const browser = resolveBrowser({ env: { LOCALAPPDATA: fake.root }, platform: 'win32', argv: [] });
    const expected = fake.app('157.0.4341.42', 'msedge.exe');
    assert.equal(chromiumExecutablePath(browser, 'msedge', {}), expected);
    assert.equal(chromiumLaunchOptions({ env: { LOCALAPPDATA: fake.root }, platform: 'win32', argv: [] }).executablePath, expected);
    // Through launchBrowser, as every suite starts it: the channel stays (records still say msedge), the exe is the folder's.
    const launched = [];
    await launchBrowser({
      env: { LOCALAPPDATA: fake.root },
      platform: 'win32',
      argv: [],
      headless: true,
      hosting: null,
      launchers: { chromium: { launch: async (options) => (launched.push(options), { close: async () => {} }) } },
      report: (text) => assert.fail(text),
      exit: (code) => assert.fail(`exit ${code}`),
    });
    assert.equal(launched[0].channel, 'msedge');
    assert.equal(launched[0].executablePath, expected);
  } finally {
    fake.done();
  }
});

test('after the swap, with the old folder still on disk, Edge starts from the new version', () => {
  const fake = edge({
    'msedge.exe': '157.0.4341.46',
    '157.0.4341.42/msedge.exe': '157.0.4341.42',
    '157.0.4341.46/msedge.exe': '157.0.4341.46',
  });
  try {
    assert.equal(installedVersionExecutable(fake.app('msedge.exe')), fake.app('157.0.4341.46', 'msedge.exe'));
  } finally {
    fake.done();
  }
});

test('an unreadable top-level version takes the newest folder that is not the pending update', () => {
  const fake = edge({
    'msedge.exe': null,
    'new_msedge.exe': '158.0.1.0',
    '157.0.4341.9/msedge.exe': '157.0.4341.9',
    '157.0.4341.42/msedge.exe': '157.0.4341.42',
    '158.0.1.0/msedge.exe': '158.0.1.0',
    'SetupMetrics/msedge.exe': '1.0.0.0',
  });
  try {
    assert.equal(installedVersionExecutable(fake.app('msedge.exe')), fake.app('157.0.4341.42', 'msedge.exe'));
  } finally {
    fake.done();
  }
});

test('no version folder with the exe (Chrome keeps only a stub at the top), another platform, or no install: as before', () => {
  const chrome = install(['Google', 'Chrome'], 'chrome.exe', {
    'chrome.exe': '157.0.8103.39',
    'new_chrome.exe': '157.0.8103.51',
    '157.0.8103.39': 'dir',
    '157.0.8103.51': 'dir',
  });
  const bare = edge({ 'msedge.exe': '157.0.4341.42' });
  try {
    const env = { LOCALAPPDATA: chrome.root, MARGO_BROWSER: 'chrome' };
    assert.equal(channelExecutable(resolveBrowser({ env, platform: 'win32', argv: [] }), 'chrome'), chrome.app('chrome.exe'));
    assert.equal(installedVersionExecutable(bare.app('msedge.exe')), bare.app('msedge.exe'));
    assert.equal(channelExecutable(resolveBrowser({ env: { LOCALAPPDATA: bare.root }, platform: 'linux', argv: [] }), 'msedge'), undefined);
    assert.equal(channelExecutable(resolveBrowser({ env: {}, platform: 'win32', argv: [] }), 'msedge'), undefined);
    // An executable the caller or BROWSER_EXECUTABLE names still wins over the install.
    const own = resolveBrowser({ env: { LOCALAPPDATA: bare.root, BROWSER_EXECUTABLE: 'D:/own/msedge.exe' }, platform: 'win32', argv: [] });
    assert.equal(chromiumExecutablePath(own, 'msedge', {}), 'D:/own/msedge.exe');
  } finally {
    chrome.done();
    bare.done();
  }
});
