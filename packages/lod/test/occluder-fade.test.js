// Occluder fade on the CPU: which meshes are found, how the fade steps, the threshold tiles and the shader patches.
// Pixels on a real GPU: occluder-fade-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../../core/dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/src/shaders.ts';
import { setRenderLayers } from '../../cameras/dist/layers.js';
import { coreFadeShader } from '@margoengine/lod/fade';
import {
  OccluderFade,
  coreOccluderShader,
  findOccluders,
  modelOccluderShader,
  occluderKeeps,
  occluderThresholds,
} from '@margoengine/lod/occluder-fade';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const only = (found, mesh) =>
  assert.ok(found.size === 1 && found.has(mesh), `found ${found.size}, expected only one mesh`);
// The camera at z = 10 looks at a target at the origin; a wall stands between them and a pillar beside the line.
async function scene(run) {
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: mockGPU().device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 10], target: [0, 0, 0] },
    null,
  );
  try {
    const mesh = (position, size = [1, 1, 1]) =>
      engine
        .createMesh()
        .setGeometry(box(...size))
        .setPosition(position);
    const parts = {
      target: mesh([0, 0, 0]),
      wall: mesh([0, 0, 5], [2, 2, 0.2]),
      beside: mesh([4, 0, 5]),
      behind: mesh([0, 0, -5], [2, 2, 0.2]),
    };
    await run(engine, parts);
  } finally {
    engine.dispose();
  }
}

test('a mesh between the camera and the target is found; one beside the line or behind the target is not', () =>
  scene((engine, { target, wall, beside, behind }) => {
    const found = findOccluders(engine, [0, 0, 10], [target]);
    only(found, wall);
    assert.equal(found.has(beside), false);
    assert.equal(found.has(behind), false);
    assert.equal(found.has(target), false, 'a target never hides itself');
    // A sphere target, also from a function, finds the same wall; a bare point inside the box is hidden by the box too.
    only(findOccluders(engine, [0, 0, 10], [[0, 0, 0, 0.9]]), wall);
    only(findOccluders(engine, [0, 0, 10], [() => [0, 0, 0, 0.9]]), wall);
    const point = findOccluders(engine, [0, 0, 10], [[0, 0, 0]]);
    assert.ok(point.size === 2 && point.has(wall) && point.has(target));
    // A target moved this frame is found where it is now: behind the far wall.
    target.setPosition([0, 0, -8]);
    const moved = findOccluders(engine, [0, 0, 10], [target]);
    assert.ok(moved.size === 2 && moved.has(behind));
    target.setPosition([0, 0, 0]);
    // From the side nothing is in the way.
    assert.equal(findOccluders(engine, [-10, 0, 0], [target]).size, 0);
  }));

test('padding widens the sight line; layers and filter keep meshes solid', () =>
  scene((engine, { target, wall, beside }) => {
    // The pillar's near face is 3.5 from the line.
    assert.equal(findOccluders(engine, [0, 0, 10], [target], { padding: 3 }).has(beside), false);
    assert.equal(findOccluders(engine, [0, 0, 10], [target], { padding: 3.75 }).has(beside), true);
    assert.equal(findOccluders(engine, [0, 0, 10], [target], { padding: 0 }).has(wall), true);
    assert.equal(findOccluders(engine, [0, 0, 10], [target], { filter: (mesh) => mesh !== wall }).size, 0);
    setRenderLayers(wall, 2);
    assert.equal(findOccluders(engine, [0, 0, 10], [target], { layers: 1 }).size, 0);
    only(findOccluders(engine, [0, 0, 10], [target], { layers: 2 }), wall);
  }));

test('the plugin fades an occluder out over fadeTime and back in when the view clears', () =>
  scene((engine, { target, wall, beside }) => {
    const fade = OccluderFade.attach(engine, { targets: [target], fadeTime: 1, minOpacity: 0.2 });
    fade.update(0.5);
    only(fade.occluders, wall);
    assert.ok(Math.abs(fade.opacityOf(wall) - 0.6) < 1e-6, `halfway to 0.2: ${fade.opacityOf(wall)}`);
    assert.equal(fade.opacityOf(beside), 1);
    fade.update(2);
    assert.ok(Math.abs(fade.opacityOf(wall) - 0.2) < 1e-6, 'it stops at minOpacity');
    assert.equal(fade.active, 1);
    // The camera moves to the side: the wall comes back.
    engine.camera.position = [-10, 0, 0];
    fade.update(0.5);
    assert.equal(fade.occluders.size, 0);
    assert.ok(Math.abs(fade.opacityOf(wall) - 0.6) < 1e-6);
    fade.update(0.5);
    assert.equal(fade.opacityOf(wall), 1);
    assert.equal(fade.active, 0);
    // A mesh disposed while faded leaves no fade behind for the next mesh with its id.
    engine.camera.position = [0, 0, 10];
    fade.update(1);
    assert.equal(fade.active, 1);
    wall.dispose();
    fade.update(0);
    assert.equal(fade.active, 0);
    fade.enabled = false;
    fade.update(1);
    assert.equal(fade.occluders.size, 0);
    fade[Symbol.dispose]();
    assert.equal(engine.hasPlugin(fade.name), false);
    assert.throws(() => fade.update(0), { name: 'MargoError', code: 'state' });
  }));

test('options out of range are refused with the help link', () => {
  const help = /margoengine\.com\/errors#lod-occluder-fade/;
  for (const options of [
    { fadeTime: -1 },
    { fadeTime: Infinity },
    { minOpacity: 1.5 },
    { padding: -1 },
    { layers: -1 },
    { pattern: 'white' },
  ])
    assert.throws(() => new OccluderFade(options), { name: 'RangeError', message: help }, JSON.stringify(options));
  assert.throws(() => new OccluderFade({ filter: 3 }), { name: 'TypeError', message: help });
  assert.throws(() => new OccluderFade({ targets: 3 }), { name: 'TypeError', message: help });
  const fade = new OccluderFade();
  assert.deepEqual(
    [fade.fadeTime, fade.minOpacity, fade.padding, fade.pattern, fade.layers, fade.filter, fade.targets],
    [0.25, 0.25, 0.25, 'bayer', 0xffffffff, null, []],
  );
  return scene((engine) => {
    assert.throws(() => findOccluders(engine, [0, 0, 10], [[0, 0]]), { name: 'TypeError', message: help });
    assert.throws(() => findOccluders(engine, [0, NaN, 10], []), { name: 'TypeError', message: help });
  });
});

test('both tiles hold every rank once, so the kept share is the opacity', () => {
  for (const pattern of ['bayer', 'blue']) {
    const tile = occluderThresholds(pattern);
    assert.deepEqual(
      [...tile].sort((a, b) => a - b),
      Array.from({ length: 256 }, (_, i) => (i + 0.5) / 256),
      pattern,
    );
    for (const opacity of [0, 0.25, 0.5, 1]) {
      let kept = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) kept += +occluderKeeps(x, y, opacity, pattern);
      assert.equal(kept / 1024, opacity, `${pattern} at ${opacity}`);
    }
  }
  // Ordered: every 2 by 2 block of the Bayer tile at one half keeps two pixels. Blue noise has no such grid, but at
  // one half no kept pixel may sit in a 3 by 3 block that is all kept (no clumps).
  const blue = occluderThresholds('blue');
  for (let y = 0; y < 16; y += 2)
    for (let x = 0; x < 16; x += 2) {
      let kept = 0;
      for (const [a, b] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        kept += +occluderKeeps(x + a, y + b, 0.5); // prettier-ignore
      assert.equal(kept, 2);
    }
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let kept = 0;
      for (let b = 0; b < 3; b++)
        for (let a = 0; a < 3; a++) kept += +(blue[((y + b) & 15) * 16 + ((x + a) & 15)] < 0.5);
      assert.ok(kept > 0 && kept < 9, `a 3 by 3 block at ${x},${y} is all one value`);
    }
  assert.notDeepEqual([...blue], [...occluderThresholds('bayer')]);
});

test('the core patch reads the faded share of the mesh id and composes with lod/fade in either order', () => {
  const code = coreOccluderShader(wgsl);
  assert.notEqual(code, wgsl);
  assert.ok(code.includes('@group(0) @binding(92) var<storage,read> occ_fades:array<f32>;'));
  assert.ok(code.includes('vec4f {\nif(!occ_keep(i.clip.xy,occ_fades[256u+i.lod_id])){discard;}'));
  assert.equal(coreOccluderShader(code), code, 'patched once');
  assert.equal(coreOccluderShader('fn other() {}'), 'fn other() {}', 'a shader with its own outputs is not touched');
  for (const both of [coreFadeShader(code), coreOccluderShader(coreFadeShader(wgsl))]) {
    assert.equal(both.match(/lod_id:u32/g).length, 1, 'one shared mesh id');
    assert.ok(both.includes('occ_keep(i.clip.xy') && both.includes('lod_fade_keep(i.clip.xy'));
  }
});

test('the model patch guards every entry that shades a surface', () => {
  const source = '@fragment fn a() {let s=surface(i,front);}\n@fragment fn b() {let s=surface(i,front);}',
    code = modelOccluderShader(source, 2);
  assert.match(code, /@group\(2\) @binding\(92\) var<uniform> occ_fade:OccFade;/);
  assert.equal(code.match(/if\(!occ_keep\(i\.clip\.xy\)\)\{discard;\}/g).length, 2);
});

test('a model in the way is found whole, and a skinned or morphed one by the sphere of its rest shape', async () => {
  const { parseGLTFAsync } = await import('../../gltf/dist/pbr.js'),
    { exportGLB } = await import('../../exporters/dist/index.js');
  await scene(async (engine, { target, wall }) => {
    wall.dispose();
    const geometry = {
        positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2],
      },
      model = await parseGLTFAsync(engine, exportGLB({ nodes: [{ name: 'Pane', translation: [0, 0, 5], geometry }] }));
    try {
      only(findOccluders(engine, [0, 0, 10], [target]), model);
      assert.equal(findOccluders(engine, [0, 0, 10], [model]).size, 0, 'a model target never hides itself');
      // A pose lives on the GPU only: the raycaster refuses the primitive, the rest-shape sphere stands in for it.
      model.primitives[0].deformed = {};
      only(findOccluders(engine, [0, 0, 10], [target]), model);
      assert.equal(findOccluders(engine, [0, 0, 10], [target], { filter: () => false }).size, 0);
      // Past the sphere (radius about 1.4 around z = 5, x = 0) nothing is found.
      assert.equal(findOccluders(engine, [3, 0, 10], [[3, 0, 0, 0.5]], { padding: 0 }).size, 0);
    } finally {
      model.dispose();
    }
  });
});
