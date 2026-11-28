// The load-and-store attachments that vfx flocking and water liquid-mpm share (packages/shared/load-attachments.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAttachments } from '../packages/shared/load-attachments.js';

test('colour and depth both load and store what the frame holds', () => {
  const { color, depth } = loadAttachments();
  assert.equal(color.loadOp, 'load');
  assert.equal(color.storeOp, 'store');
  assert.equal(depth.depthLoadOp, 'load');
  assert.equal(depth.depthStoreOp, 'store');
  assert.equal(color.view, undefined);
  assert.equal(depth.view, undefined);
});

test('every call returns a pair of its own, so two effects never share a view', () => {
  const a = loadAttachments(),
    b = loadAttachments();
  a.color.view = 'a';
  a.depth.view = 'a';
  assert.equal(b.color.view, undefined);
  assert.equal(b.depth.view, undefined);
  assert.notEqual(a.color, b.color);
  assert.notEqual(a.depth, b.depth);
});

test('vfx flocking and water liquid-mpm take their attachments from it', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['packages/vfx/src/flocking.ts', 'packages/water/src/liquid-mpm.ts'])
    assert.match(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /loadAttachments\(\)/, file);
});
