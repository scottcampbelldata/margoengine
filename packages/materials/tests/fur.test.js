import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { pbrShader } from '../../gltf-pro/src/shader.ts';
import { shadowDepth } from '../../shadows/src/shader.ts';
import { Fur, FurMaterial, createFur } from '../dist/fur.js';

const geometry = {
  positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0.5, 1],
  indices: [0, 1, 2],
};
const calls = (log, name) => log.filter((e) => e[0] === name);

test('fur defaults, bounds and invalid controls reject before GPU allocation', () => {
  const m = new FurMaterial();
  assert.equal(m.fur.length, 0.1);
  assert.equal(m.fur.density, 64);
  assert.deepEqual(m.fur.gravity, [0, -0.3, 0]);
  for (const fur of [
    { length: -1 },
    { density: -1 },
    { density: Infinity },
    { coverage: 1.1 },
    { layer: 1.1 },
    { gravity: [1, 2] },
    { wind: [NaN, 0, 0] },
    { seed: 1.5 },
    { time: Infinity },
    { rootShade: -1 },
  ])
    assert.throws(
      () => new FurMaterial({ fur }),
      (e) => e instanceof RangeError || e instanceof TypeError,
    );
  assert.doesNotThrow(() => new FurMaterial({ fur: { density: 0, length: 0, coverage: 0 } }));
  m.dispose();
});

test('shell uniforms update live, steady draws upload nothing and clones own their state', () => {
  const gpu = mockGPU(),
    m = new FurMaterial({ fur: { wind: [1, 0, 0] } });
  const first = gpu.record(() => m.bindings(gpu.device));
  assert.equal(calls(first, 'buffer').filter((e) => e[2].size === 64).length, 1);
  assert.equal(
    calls(
      gpu.record(() => m.bindings(gpu.device)),
      'writeBuffer',
    ).length,
    0,
  );
  m.fur.time = 0.25;
  assert.equal(
    calls(
      gpu.record(() => m.bindings(gpu.device)),
      'writeBuffer',
    ).length,
    1,
  );
  const clone = m.clone();
  assert.ok(clone instanceof FurMaterial);
  assert.notEqual(clone.fur, m.fur);
  assert.notEqual(clone.fur.wind, m.fur.wind);
  clone.fur.time = 1;
  assert.equal(m.fur.time, 0.25);
  assert.equal(
    calls(
      gpu.record(() => clone.bindings(gpu.device)),
      'buffer',
    ).filter((e) => e[2].size === 64).length,
    1,
  );
  clone.dispose();
  m.dispose();
  m.dispose();
});

test('beauty and caster use the identical strand mask and force field, with valid output separators', () => {
  const m = new FurMaterial(),
    gpu = mockGPU(),
    beauty = m.shader(pbrShader, 1),
    caster = m.caster(gpu.device),
    depth = caster.depth(shadowDepth(true), 2);
  assert.match(beauty, /margoFurMove\(i.normal.xyz,i.uv.xy\)/);
  assert.match(depth, /margoFurMove\(i.normal.xyz,i.uv.xy\)/);
  assert.match(beauty, /if\(margoFurCoverage\(i.uv.xy\)<0.5\)/);
  assert.match(depth, /if\(margoFurCoverage\(i.margoFurUV\)<0.5\)/);
  assert.match(depth, /,@location\(7\) margoFurUV:vec2f/);
  assert.equal(caster.cuts, true);
  assert.ok(beauty.includes('fn margoFurCoverage'));
  assert.ok(depth.includes('fn margoFurCoverage'));
  assert.equal(caster.entries()[0].binding, 180);
  assert.ok(caster.layout());
  m.dispose();
});

test('createFur owns a complete parented shell stack, updates controls atomically and disposes it', async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(64);
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 5], target: [0, 0, 0] },
    null,
  );
  const fur = Fur.attach(engine, geometry, { shells: 8, fur: { length: 0.3 } });
  assert.equal(fur.shells.length, 8);
  assert.equal(fur.root, fur.shells[0].root);
  assert.deepEqual(
    fur.shells.map((m) => m.material.fur.layer),
    Array.from({ length: 8 }, (_, k) => k / 8),
  );
  for (const shell of fur.shells.slice(1)) assert.equal(store.parents[shell.root.id], fur.root.id);
  fur.setTime(2);
  assert.ok(fur.shells.every((m) => m.material.fur.time === 2));
  assert.throws(() => fur.setTime(NaN), RangeError);
  fur.setOptions({ density: 8, wind: [1, 0, 0] });
  assert.ok(fur.shells.every((m) => m.material.fur.density === 8));
  assert.deepEqual(
    fur.shells.map((m) => m.material.fur.layer),
    Array.from({ length: 8 }, (_, k) => k / 8),
  );
  assert.throws(() => fur.setOptions({ density: -1 }), RangeError);
  assert.ok(fur.shells.every((m) => m.material.fur.density === 8));
  fur.dispose();
  fur.dispose();
  const coarse = createFur(engine, geometry, { shells: 2 });
  assert.deepEqual(
    coarse.shells.map((m) => m.material.fur.layer),
    [0, 0.5],
    'the coarsest stack has a visible outer sample below the fully tapered tip',
  );
  coarse.dispose();
  assert.throws(
    () => fur.setTime(1),
    (e) => e.code === 'disposed',
  );
  assert.equal(engine.meshes.size, 0);
  engine.dispose();
});

// KB5588b: an inherited displacementMap moved the beauty shells but not their shadow casters (the fur caster replaced
// the map's record), and TAA had no velocity patch for fur, so it took the fur record for a texture displacement.
test('fur casters move on top of an inherited displacementMap and give TAA a velocity patch', async () => {
  const { Texture } = await import('../dist/index.js');
  const { objectVelocity } = await import('../../taa/src/shader.ts');
  const { displacedDepth } = await import('../../shared/displacement.js');
  const gpu = mockGPU(),
    store = await TransformStore.create(64);
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 5], target: [0, 0, 0] },
    null,
  );
  const map = new Texture({ data: new Uint8Array(16).fill(255), width: 2, height: 2 }, { mipmaps: false });
  const fur = createFur(engine, geometry, { shells: 2, displacementMap: map, displacementScale: 0.2 });
  try {
    const record = fur.shells[1].primitives[0].material.displacement;
    assert.ok(record?.depth, 'the shell casts through the fur record');
    assert.equal(record, fur.shells[1].primitives[0].material.displacement, 'the record is kept while unchanged');
    const depth = displacedDepth(shadowDepth(true), 2, record);
    assert.match(depth, /vec4f\(i\.position\.xyz\+i\.normal\.xyz\*margoDisplacement\(i\.uv\)\+margoFurMove\(/);
    assert.match(depth, /var margoDisplacementMap:texture_2d<f32>/);
    assert.deepEqual(
      record.entries().map((e) => e.binding),
      [0, 1, 2, 180],
    );
    assert.ok(record.key.endsWith(':map'), 'a mapped caster has its own pipeline key');
    // TAA builds the graph form with the move run again on last frame's fur block.
    const velocity = objectVelocity(true, false, false, false, true, false, record.velocity, {
      move: record.move,
      binding: record.program.next,
    });
    assert.match(velocity, /var margoPosition=i\.position\.xyz\+i\.normal\.xyz\*margoDisplacement\(i\.uv\)\+margoFurMove\(/);
    assert.match(velocity, /margoFurMoveWith\(nduBefore\.shape,nduBefore\.gravity,nduBefore\.wind,nduBefore\.clock,/);
    assert.match(velocity, /@group\(1\) @binding\(181\) var<uniform> nduBefore:NdUniforms;/);
    assert.match(velocity, /alias NdUniforms=MargoFur;/);
    assert.match(velocity, /->Motion \{if\(margoFurCoverage\(i\.uv\.xy\)<0\.5\)\{discard;\}/);
    assert.ok(record.program.buffers.get(gpu.device)?.bytes.byteLength === 64, 'TAA reads the 64-byte fur block');
    // Without a map the record keeps the plain fur move, and TAA's patch too.
    const plain = fur.shells[0].material.caster(gpu.device);
    assert.doesNotMatch(plain.depth(shadowDepth(true), 2), /margoDisplacement/);
    assert.deepEqual(
      plain.entries().map((e) => e.binding),
      [180],
    );
  } finally {
    fur.dispose();
    map.dispose();
    engine.dispose();
  }
});
