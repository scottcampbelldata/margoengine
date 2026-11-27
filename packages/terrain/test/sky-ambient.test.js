import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../dist/index.js';
import { TerrainMaterials } from '../dist/layers-pbr.js';
import { Sky } from '../../sky/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// KB-TERRAIN-SKYAMBIENT1: terrain's ambient was a flat white `radiance[3]` that ignored the sky's light and
// `lighting.ambient`, and `Sky.add(terrain)` threw (terrain's lighting contract is shader/bindings, the sky gave pbr).
const layers = 4;
function rig() {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: {
        direction: new Float32Array([0, 1, 0, 3]),
        radiance: new Float32Array([1, 1, 1, 0.15]),
        ambient: new Float32Array([1, 1, 1]),
      },
      stats: { drawCalls: 0 },
      removePlugin() {},
      sceneOf: () => undefined,
      disposed: false,
    },
    texture = (device, format, count = 1) => device.createTexture({ size: [4, 4, count], format, usage: 6 }),
    terrain = new Terrain({
      resolution: 8,
      levels: 2,
      size: [32, 32],
      layers: Array.from({ length: layers }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
      textures: (device) => ({
        heightmap: device.createTexture({ size: [4, 4, 1], format: 'r32float', usage: 7 }),
        layers: texture(device, 'rgba8unorm', layers),
      }),
    });
  terrain.setup(engine);
  const materials = new TerrainMaterials(terrain, {
    textures: (device) => ({
      normals: texture(device, 'rgba8unorm', layers),
      surface: texture(device, 'rgba8unorm', layers),
    }),
  });
  return { terrain, materials, engine };
}
// A sky whose ambient is on, and a frame that builds its light (the harness's GPU stands in for the device).
function litSky() {
  const h = optionalGPU(),
    sky = new Sky({ timeScale: 0, lighting: { ambient: { day: [0.1, 0.1, 0.1], night: [0.01, 0.01, 0.01] } } });
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  h.engine.use(sky);
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  return { sky, frame };
}
const linearOf = (code) => {
  const lines = code.match(/let linear=[^;]+;/g);
  assert.equal(lines?.length, 1, 'one lit line');
  return lines[0];
};

test("Sky.add(terrain) puts the sky's light in place of terrain's flat ambient, whatever order the layer materials attach in (KB-TERRAIN-SKYAMBIENT1)", () => {
  const { terrain, materials, engine } = rig(),
    { sky, frame } = litSky();
  // Before the fix: TypeError, terrain wants shader() and bindings().
  const detach = sky.add(terrain);
  materials.setup(engine);
  // Until the sky's first ambient frame the shader and the lighting group are what they were.
  assert.match(linearOf(terrain.shader()), /\+base\*frame\.radiance\.w\*frame\.ambient\.rgb\*terrainPbrOcclusion\(\)/);
  assert.deepEqual(sky.bindings(), []);
  frame();
  const code = terrain.shader(),
    linear = linearOf(code);
  assert.ok(
    code.includes('let margoAmbient=skyLighting(n,v,base,0.0,i.material.x,vec3f(0.04),1.0);let linear='),
    'the sky light from the shaded normal, view and albedo',
  );
  assert.ok(linear.endsWith('+margoAmbient*terrainPbrOcclusion();'), `occluded as the flat term was: ${linear}`);
  assert.ok(!linear.includes('frame.radiance.w'), `the flat term is gone: ${linear}`);
  assert.match(code, /@group\(1\) @binding\(8\) var<uniform> skyLight:array<vec4f,10>;/);
  // The sky's three bindings join the terrain's lighting group beside the layer materials', none twice.
  const bound = [...terrain.lighting].flatMap((effect) => effect.bindings().map((entry) => entry.binding)),
    declared = [...code.matchAll(/@group\(1\) @binding\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    [8, 10, 11].filter((b) => !bound.includes(b)),
    [],
  );
  assert.deepEqual(
    [...bound].sort((a, b) => a - b),
    [...declared].sort((a, b) => a - b),
  );
  assert.equal(new Set(bound).size, bound.length, `bound once each: ${bound}`);
  // Removed, the terrain is lit as before.
  detach();
  assert.match(linearOf(terrain.shader()), /\+base\*frame\.radiance\.w\*frame\.ambient\.rgb\*terrainPbrOcclusion\(\)/);
  sky.dispose();
});

test("terrain's flat ambient takes lighting.ambient, as core meshes do (KB-TERRAIN-SKYAMBIENT1)", () => {
  const { terrain } = rig(),
    code = terrain.shader();
  assert.match(code, /struct Frame \{[^}]*heights:vec4f,ambient:vec4f\}/);
  assert.ok(linearOf(code).endsWith('+base*frame.radiance.w*frame.ambient.rgb;'), linearOf(code));
});

test('a sky on a shader without terrain ambient throws a coded error', () => {
  const { sky, frame } = litSky();
  frame();
  const target = { addLighting: (effect) => ((target.effect = effect), () => {}) };
  sky.add(target);
  assert.throws(
    () =>
      target.effect.finish(
        '@fragment fn fragment()->@location(0) vec4f {let linear=vec3f(1);return vec4f(linear,1);}',
        1,
      ),
    (e) => e.code === 'unsupported',
  );
  sky.dispose();
});
