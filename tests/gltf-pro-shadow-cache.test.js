import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { box } from '../packages/core/dist/index.js';
import { PBRModel, parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { Shadows } from '../packages/shadows/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';

// This is an optional-package handshake, deliberately absent from the public
// package exports. The public getter still returns independent snapshots.
const writerKey = Symbol.for('@margoengine/internal/shadowPrimitivesInto');

async function scene(t) {
  const h = optionalGPU(),
    store = await TransformStore.create(16);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const fixture = animatedTriangle();
  fixture.doc.nodes = [{ mesh: 0 }, { mesh: 0 }];
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const model = parseGLTF(engine, fixture.doc, fixture.buffers);
  // Distinct material objects let a nested draw mutate the second caster.
  model.primitives[1].material = {
    ...model.primitives[0].material,
    base: model.primitives[0].material.base.slice(),
    settings: model.primitives[0].material.settings.slice(),
  };
  engine.camera.update(4 / 3, true);
  store.tick(false);
  t.after(() => engine.dispose());
  return { h, engine, model, context: { ...h.context, camera: engine.camera } };
}

test('public shadow snapshots remain independent while the internal writer reuses caller-owned descriptors', async (t) => {
  const { model, h, engine } = await scene(t),
    first = model.shadowPrimitives,
    second = model.shadowPrimitives;
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  const left = [],
    right = [],
    write = model[writerKey];
  assert.equal(write.call(model, left), true);
  assert.equal(write.call(model, right), true);
  assert.deepEqual(left, first);
  assert.notEqual(left[0], right[0]);
  const reused = left[0],
    oldVertex = first[0].vertex,
    primitive = model.primitives[0];
  const deformed = h.engine.gpu.createBuffer({ size: primitive.vertices.byteLength, usage: GPUBufferUsage.VERTEX });
  t.after(() => deformed.destroy());
  primitive.deformed = deformed;
  primitive.material.base[3] = 0.4;
  primitive.material.settings[0] = 1;
  primitive.material.settings[1] = 0.25;
  primitive.material.maps[0] = { texCoord: 1 };
  model.primitives[1].material.settings[0] = 2;
  assert.equal(write.call(model, left), true);
  assert.equal(left.length, 1);
  assert.equal(left[0], reused);
  assert.equal(left[0].vertex, deformed);
  assert.equal(left[0].cutoff, 0.25);
  assert.equal(left[0].texCoord, 1);
  assert.equal(left[0].alpha, primitive.material.base[3]);
  assert.equal(first.length, 2);
  assert.equal(first[0].vertex, oldVertex);
  assert.equal(first[0].alpha, 1);
  assert.equal(right[0].vertex, oldVertex);
  model.primitives[1].material.settings[0] = 0;
  model.primitives[1].topology = 'line-list';
  write.call(model, left);
  assert.equal(left.length, 1);
  delete model.primitives[1].topology;
  primitive.material.maps[0] = undefined;
  model.onDeviceRestored(engine);
  write.call(model, left);
  assert.equal(left.length, 2);
  assert.equal(left[0], reused);
  assert.notEqual(left[0].vertex, oldVertex);
  assert.notEqual(left[0].vertex, deformed);
  assert.deepEqual(left, model.shadowPrimitives);
});

test('internal shadow writes defer to instance, subclass, data-property and changed prototype getters', async (t) => {
  const { model } = await scene(t),
    write = model[writerKey],
    original = Object.getPrototypeOf(model);
  const descriptor = Object.getOwnPropertyDescriptor(PBRModel.prototype, 'shadowPrimitives'),
    sentinel = [];
  Object.defineProperty(model, 'shadowPrimitives', { configurable: true, get: () => sentinel });
  assert.equal(write.call(model, []), false);
  assert.equal(model.shadowPrimitives, sentinel);
  Object.defineProperty(model, 'shadowPrimitives', { configurable: true, value: sentinel });
  assert.equal(write.call(model, []), false);
  delete model.shadowPrimitives;
  class Custom extends PBRModel {
    get shadowPrimitives() {
      return sentinel;
    }
  }
  Object.setPrototypeOf(model, Custom.prototype);
  assert.equal(write.call(model, []), false);
  assert.equal(model.shadowPrimitives, sentinel);
  Object.setPrototypeOf(model, original);
  Object.defineProperty(PBRModel.prototype, 'shadowPrimitives', { ...descriptor, get: () => sentinel });
  try {
    assert.equal(write.call(model, []), false);
  } finally {
    Object.defineProperty(PBRModel.prototype, 'shadowPrimitives', descriptor);
  }
  assert.equal(write.call(model, []), true);
});

test('Shadows retains its own snapshots across nested draws, callback failure and mutable caster changes', async (t) => {
  const { model, engine, context } = await scene(t);
  const shadows = new Shadows({ resolution: 16, bounds: { min: [-2, -2, -2], max: [2, 2, 2] } });
  engine.use(shadows);
  shadows.add(model);
  const seen = [];
  let nested = false,
    once = true;
  shadows.draw = (_pass, primitive) => {
    seen.push({ nested, reference: primitive, node: primitive.node, alpha: primitive.alpha });
    if (!nested && once) {
      once = false;
      nested = true;
      model.primitives[1].material.base[3] = 0.25;
      shadows.depth(context, 0, false);
      nested = false;
    }
  };
  shadows.depth(context, 0, false);
  const outer = seen.filter((value) => !value.nested),
    inner = seen.filter((value) => value.nested);
  assert.equal(outer.length, 2);
  assert.equal(inner.length, 2);
  assert.equal(outer[1].alpha, 1);
  assert.equal(inner[1].alpha, 0.25);
  assert.notEqual(outer[0].reference, inner[0].reference);
  const held = outer[0].reference,
    failure = new Error('caller draw failed');
  shadows.draw = () => {
    throw failure;
  };
  assert.throws(
    () => shadows.depth(context, 0, false),
    (error) => error === failure,
  );
  seen.length = 0;
  shadows.draw = (_pass, primitive) => seen.push(primitive);
  model.primitives[1].material.settings[0] = 2;
  shadows.depth(context, 0, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], held);
});

test('Shadows reads an overridden public getter on every pass instead of bypassing custom casters', async (t) => {
  const { model, engine, context } = await scene(t);
  const shadows = new Shadows({ resolution: 16, bounds: { min: [-2, -2, -2], max: [2, 2, 2] } });
  engine.use(shadows);
  shadows.add(model);
  const caster = model.shadowPrimitives[1],
    seen = [];
  let reads = 0;
  Object.defineProperty(model, 'shadowPrimitives', {
    configurable: true,
    get() {
      reads++;
      return [caster];
    },
  });
  shadows.draw = (_pass, primitive) => seen.push(primitive);
  shadows.depth(context, 0, false);
  shadows.depth(context, 0, false);
  assert.equal(reads, 2);
  assert.deepEqual(seen, [caster, caster]);
});

test('registered PBR mesh casters keep the full directional shadow range alongside nearby core meshes', async (t) => {
  const { engine, model } = await scene(t),
    shadows = new Shadows({ resolution: 16 });
  engine.use(shadows);
  const core = engine.createMesh().setGeometry(box());
  shadows.add(core);
  shadows.add(model.nodes[0]);
  engine.store.tick(false);
  assert.equal(
    shadows.range(engine.camera).far,
    Math.min(engine.camera.far, 500),
    'PBR receiver bounds are not represented by core geometry spheres',
  );
});
