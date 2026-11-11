// "Pay only for what you import": a page that never imports @margoengine/lines/tiles carries none of its code, uploads
// the 96-byte Frame and compiles shaders without the capture step. 3e6479d7e had put the tile row and the capture
// branch into the root renderer (docs/whitepaper/claims.md, lines-perspective). This file never imports lines/tiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Camera } from '@margoengine/core';
import { Line } from '../dist/index.js';
import { LineBatch, LineBatches } from '../dist/batch.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { rig } from './gpu-rig.js';

const dist = resolve(import.meta.dirname, '../dist');
/** An entry's code with every chunk it imports statically, as a bundler would include it. */
function reachable(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  const code = readFileSync(resolve(dist, file), 'utf8');
  let all = code;
  for (const [, chunk] of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) all += reachable(chunk, seen);
  return all;
}

test('the built root, batch and pick entries hold no tile code; lines/tiles holds all of it', () => {
  for (const entry of ['index.js', 'batch.js', 'pick.js']) {
    const code = reachable(entry);
    assert.doesNotMatch(code, /captureClip|tile:vec4f|fullWidth/, `${entry} carries tiled-capture code`);
  }
  assert.match(reachable('tiles.js'), /captureClip/);
});

const frameLayouts = (log) =>
  log.filter((e) => e[0] === 'layout' && e[2].entries.length === 1 && e[2].entries[0].buffer?.type === 'uniform');

test('without lines/tiles, Lines uploads the 96-byte Frame and every shader is the base text', () => {
  const { lines, frame, setup } = rig();
  for (const options of [{}, { dashed: true, dashCap: 'round' }, { mode: 'segments' }, { alphaToCoverage: true }])
    lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0, 2, 0, 0], ...options }));
  const log = [...setup, ...frame(), ...frame(1 / 60)];
  assert.equal(frameLayouts(setup)[0][2].entries[0].buffer.minBindingSize, 96);
  assert.ok(
    log.some((e) => e[0] === 'buffer' && e[2].size === 96),
    'a 96-byte frame buffer',
  );
  assert.ok(!log.some((e) => e[0] === 'buffer' && e[2].size === 112), 'no 112-byte frame buffer');
  const writes = log.filter((e) => e[0] === 'writeBuffer').map((e) => e[3].length / 2);
  assert.ok(writes.includes(96) && !writes.includes(112), `frame writes ${writes}`);
  const modules = log.filter((e) => e[0] === 'module').map((e) => e[2].code);
  assert.ok(modules.length >= 2, `${modules.length} shader modules`);
  for (const code of modules) {
    assert.match(code, /struct Frame\{viewProj:mat4x4f,viewport:vec4f,extra:vec4f\}\n/);
    assert.doesNotMatch(code, /captureClip|tile:vec4f/);
  }
  lines.dispose();
});

test('without lines/tiles, LineBatches uploads the 96-byte Frame and the base shader', () => {
  const gpu = mockGPU(),
    batches = new LineBatches(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const log = gpu.record(() => {
    batches.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } });
    batches.add(new LineBatch({ positions: [0, 0, 0, 1, 0, 0] }));
    passes(batches)({
      backend: 'webgpu',
      device: gpu.device,
      encoder: gpu.encoder,
      camera,
      width: 64,
      height: 64,
      format: 'rgba8unorm',
      color: view,
      depth: view,
      descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
    });
  });
  assert.equal(frameLayouts(log)[0][2].entries[0].buffer.minBindingSize, 96);
  assert.ok(log.some((e) => e[0] === 'writeBuffer' && e[3].length === 192));
  for (const e of log.filter((e) => e[0] === 'module')) assert.doesNotMatch(e[2].code, /captureClip|tile:vec4f/);
  batches.dispose();
});
