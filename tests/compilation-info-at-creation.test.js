// Engine code asks a shader module for its compilation info when it creates the module. Chromium (Edge 156 on the RTX
// A6000 PC) leaves a getCompilationInfo() asked later, once the device has gone idle, pending until some other GPU
// request runs: RawShaderMaterial's error report waited on one (fixed in 9059a5e6), and a test suite sat until its
// 30 minute lock limit on 41 of them. The browser checks' WGSL guard answers a late call in test pages with the answer
// asked for at creation (scripts/support/wgsl-guard.js), so the GPU suites no longer see a late call in engine code;
// this check finds one in the source instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/', import.meta.url));
/** Lines a request may follow its module's createShaderModule call by. */
const WINDOW = 5;

/** Calls of getCompilationInfo in `text` not within WINDOW lines after a createShaderModule call, as line numbers. */
function lateRequests(text) {
  const lines = text.split('\n'),
    late = [];
  lines.forEach((line, i) => {
    if (!/\.getCompilationInfo\??\.?\(/.test(line)) return;
    const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
    if (!/createShaderModule\(/.test(before)) late.push(i + 1);
  });
  return late;
}

function sources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

test('the scan flags a request made away from the module it asks about', () => {
  assert.deepEqual(
    lateRequests('const m = device.createShaderModule({ code });\nconst info = m.getCompilationInfo();'),
    [],
  );
  const late = [
    'const m = device.createShaderModule({ code });',
    ...Array(6).fill('draw();'),
    'await m.getCompilationInfo();',
  ];
  assert.deepEqual(lateRequests(late.join('\n')), [8]);
  assert.deepEqual(lateRequests('const infos = modules.map((m) => m.getCompilationInfo?.());'), [1]);
});

test('engine packages ask for compilation info only when they create the module', () => {
  const late = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    let files;
    try {
      files = sources(join(root, dir.name, 'src'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files)
      for (const line of lateRequests(readFileSync(file, 'utf8')))
        late.push(`${file.slice(root.length - 'packages/'.length)}:${line}`);
  }
  assert.deepEqual(late, [], 'ask getCompilationInfo() right after createShaderModule and keep the promise');
});
