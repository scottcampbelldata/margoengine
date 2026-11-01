import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';
import { GPUMemory, statsReport, textureBytes } from '../dist/report.js';

const device = () => {
  const made = () => ({
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  });
  return { createBuffer: made, createTexture: made };
};
test('textureBytes counts mips, layers, samples and compressed blocks', () => {
  assert.equal(textureBytes({ size: [4, 4], format: 'rgba8unorm' }), 64);
  assert.equal(textureBytes({ size: [4, 4], format: 'rgba8unorm', mipLevelCount: 3 }), 84);
  assert.equal(textureBytes({ size: { width: 2, height: 2, depthOrArrayLayers: 6 }, format: 'depth32float' }), 96);
  assert.equal(textureBytes({ size: [2, 2], format: 'rgba16float', sampleCount: 4 }), 128);
  assert.equal(textureBytes({ size: [5, 4], format: 'bc1-rgba-unorm' }), 16);
  assert.equal(textureBytes({ size: [4, 4], format: 'astc-4x4-unorm' }), 16);
  assert.equal(textureBytes({ size: [4, 4, 4], format: 'r8unorm', dimension: '3d', mipLevelCount: 2 }), 72);
});
test('GPUMemory follows creates and destroys once each, by label, and restores the device', () => {
  const d = device(),
    { createBuffer } = d,
    memory = GPUMemory.attach(d),
    a = d.createBuffer({ size: 100, label: 'a' }),
    t = d.createTexture({ size: [2, 2], format: 'r8unorm' });
  assert.equal(memory.bytes, 104);
  a.destroy();
  a.destroy();
  assert.equal(a.destroyed, 2);
  const report = memory.toJSON();
  assert.deepEqual(report.buffers, { count: 0, bytes: 0 });
  assert.deepEqual(report.textures, { count: 1, bytes: 4 });
  assert.deepEqual(report.labels.a, { count: 0, bytes: 0 });
  assert.deepEqual(report.labels[''], { count: 1, bytes: 4 });
  memory.dispose();
  assert.equal(d.createBuffer, createBuffer);
  t.destroy();
  assert.equal(memory.bytes, 0, 'an object made while counting still counts down');
});
test('statsReport gives frames oldest first, survives JSON, and the view row goes with dispose', () => {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({ parent: dom.window.document.body, samples: 3 });
  for (const ms of [10, 20, 30, 40]) stats.tick(ms);
  const memory = GPUMemory.attach(device()).view(stats),
    report = JSON.parse(JSON.stringify(statsReport(stats, memory)));
  assert.deepEqual(report.frames, [20, 30, 40]);
  assert.equal(report.memory.bytes, 0);
  assert.match(stats.element.textContent, /GPU 0.0 MB, 0 buffers, 0 textures/);
  memory.dispose();
  assert.doesNotMatch(stats.element.textContent, /GPU 0.0 MB/);
  assert.equal(statsReport(stats).memory, undefined);
  stats.dispose();
  dom.window.close();
});
