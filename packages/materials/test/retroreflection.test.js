// retroreflection() on a mock device: its bounds, the shader it composes, live uniforms, disposal and serialization.
// features-browser.mjs `retro` checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { clusterBrdf } from '../../shared/light-terms.js';
import { PbrMaterial, createMesh } from '../dist/index.js';
import { retroreflection } from '../dist/retroreflection.js';
import { captureMaterialLibrary, restoreMaterialLibrary } from '../dist/serialization.js';

/** The beauty shader of one quad of `material`, as a mock device receives it. */
async function drawn(material) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  createMesh(
    engine,
    { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] },
    material,
  );
  const frame = gpu.record(() => {
    store.tick(false);
    view.begin(0);
    engine.frameGraph.execute(view.c);
  });
  return frame.flatMap((e) => (e[0] === 'module' ? [e[2].code] : [])).find((c) => c.includes('fn surface('));
}

test('defaults, live values and bounds', () => {
  const feature = retroreflection();
  assert.deepEqual([feature.strength, feature.roughness, feature.color], [0.5, 0.2, [1, 1, 1]]);
  for (const bad of [-0.1, 1.1, Number.NaN, '1']) {
    assert.throws(() => retroreflection({ strength: bad }), RangeError);
    assert.throws(() => retroreflection({ roughness: bad }), RangeError);
    assert.throws(() => (feature.strength = bad), RangeError);
    assert.throws(() => (feature.roughness = bad), RangeError);
    assert.throws(() => (feature.color = [1, bad, 1]), RangeError);
  }
  assert.throws(() => retroreflection({ color: [1, 1] }), RangeError);
  assert.ok(Object.isFrozen(feature.color), 'a colour cannot be edited past its check');
  assert.equal(feature.strength, 0.5, 'a refused value changes nothing');
});

test('the shader keeps the material lighting under the mix, for the sun, local lights and the ambient term', async () => {
  const feature = retroreflection(),
    code = await drawn(new PbrMaterial({ features: [feature] }));
  assert.match(code, /@group\(2\) @binding\(160\) var<uniform> margoRetroRows/);
  assert.match(code, /fn margoRetroUnder\(s:Surface,v:vec3f,l:vec3f\)->vec3f/);
  assert.equal(code.match(/fn direct_light\(/g).length, 1);
  assert.match(code, /return mix\(margoRetroUnder\(s,v,l\),retro,margoRetroRows\.shape\.x\);/);
  assert.throws(() => feature.shader(code.replace(/fn direct_light/g, 'fn other'), 2), /needs a PbrMaterial/);
  const lit = feature.lit(
    `result+=${clusterBrdf}*nl*light.color;let margoAmbient=iblShade(iblSpecular,iblParams,s.n,v,s.base.rgb)*s.occlusion;var color=x;`,
  );
  assert.ok(
    lit.includes(`result+=mix(${clusterBrdf},margoRetroLobe(n,v,l,base),margoRetroRows.shape.x)*nl*light.color;`),
  );
  assert.match(lit, /let margoRetroV=reflect\(-v,s\.n\);/);
  assert.ok(
    lit.includes(
      'iblShade(iblSpecular,iblParams,margoRetroS.n,margoRetroV,margoRetroS.base.rgb)*margoRetroS.occlusion,margoRetroRows.shape.x);var color=x;',
    ),
    lit,
  );
});

test('uniforms follow live edits, a steady draw uploads nothing and the last detach destroys the buffer', () => {
  const { device } = mockGPU(),
    writes = [],
    destroyed = [];
  const write = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data) => {
    writes.push(Array.from(data));
    write(buffer, offset, data);
  };
  const feature = retroreflection({ strength: 1, roughness: 0.25, color: [1, 0.5, 0] }),
    first = new PbrMaterial({ features: [feature] }),
    second = new PbrMaterial({ features: [feature] });
  const [entry] = feature.bindings(device),
    buffer = entry.resource.buffer,
    destroy = buffer.destroy.bind(buffer);
  buffer.destroy = () => {
    destroyed.push(buffer);
    destroy();
  };
  assert.equal(entry.binding, 160);
  assert.deepEqual(writes.at(-1), [1, 0.25, 0, 0, 1, 0.5, 0, 0]);
  feature.bindings(device);
  assert.equal(writes.length, 1);
  feature.strength = 0.5;
  feature.color = [0, 1, 1];
  feature.bindings(device);
  assert.deepEqual(writes.at(-1), [0.5, 0.25, 0, 0, 0, 1, 1, 0]);
  first.features = [];
  assert.equal(destroyed.length, 0, 'another material still uses it');
  second.features = [];
  assert.equal(destroyed.length, 1);
  assert.notEqual(feature.bindings(device)[0].resource.buffer, buffer, 'a later use allocates again');
});

test('a saved material keeps its live retroreflection', async () => {
  const feature = retroreflection({ strength: 0.8, color: [1, 0.2, 0] });
  feature.roughness = 0.4;
  const library = await captureMaterialLibrary({ sign: new PbrMaterial({ features: [feature] }) }),
    [restored] = (await restoreMaterialLibrary(JSON.parse(JSON.stringify(library)))).sign.features;
  assert.equal(restored.name, 'retroreflection');
  assert.deepEqual([restored.strength, restored.roughness, restored.color], [0.8, 0.4, [1, 0.2, 0]]);
});
