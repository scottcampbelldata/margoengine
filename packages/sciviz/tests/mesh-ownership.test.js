import test from 'node:test';
import assert from 'node:assert/strict';
import { meshLayer } from '@margoengine/sciviz/grids';

globalThis.GPUBufferUsage = { COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };
const set = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), values: new Float32Array([0, 1, 2]),
  cells: new Uint32Array([0]), bounds: [0, 1, 0, 1, 0, 0] });
function fixture() {
  const resources = [], retained = new Set();
  const resource = () => {
    const r = { destroyed: false, destroy() { this.destroyed = true; }, createView() { return {}; } };
    resources.push(r); return r;
  };
  const device = { createBuffer: resource, createTexture: resource,
    queue: { writeBuffer() {}, writeTexture() {} }, createBindGroupLayout() {}, createBindGroup() {}, createSampler() {} };
  const renderer = { device, add(layer) { retained.add(layer); }, remove(layer) { retained.delete(layer); } };
  return { resources, retained, renderer, addLayer(layer) { return layer; } };
}

test('mesh construction releases every earlier GPU allocation when a later allocation fails', () => {
  const f = fixture(), cause = new Error('sampler allocation');
  f.renderer.device.createSampler = () => { throw cause; };
  assert.throws(() => meshLayer(f, set()), (e) => e === cause);
  assert(f.resources.length > 0);
  assert(f.resources.every((r) => r.destroyed), 'partial construction leaked a buffer or texture');
  assert.equal(f.retained.size, 0);
});

test('mesh malformed-data failure releases construction allocations', () => {
  const f = fixture(), bad = { ...set(), normals: new Float32Array() };
  assert.throws(() => meshLayer(f, bad), /normal/);
  assert(f.resources.length > 0);
  assert(f.resources.every((r) => r.destroyed));
  assert.equal(f.retained.size, 0);
});

test('mesh failed figure publication rolls back renderer ownership and all resources', () => {
  const f = fixture(), cause = new Error('3D linear axes required');
  f.addLayer = () => { throw cause; };
  assert.throws(() => meshLayer(f, set()), (e) => e === cause);
  assert.equal(f.retained.size, 0, 'failed publication left a drawable registered');
  assert(f.resources.every((r) => r.destroyed));
});

test('native mesh refusal is help-linked and precedes allocations', () => {
  const f = fixture(); f.renderer.device = undefined;
  assert.throws(() => meshLayer(f, set()), (e) => e.code === 'unsupported' && /https:/.test(e.message));
  assert.equal(f.resources.length, 0);
});
