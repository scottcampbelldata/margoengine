// CPU checks of @margoengine/scatter/states: the fire and flood formulas against their published forms, the shader
// edits on the real pose text (alone and under the trample edit), the slider rows and the option checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { Scatter } from '../dist/index.js';
import { TrampledScatter } from '../dist/interact.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';
import {
  PLANT_STATE_LOOKS,
  PLANT_STATE_SETTINGS,
  PlantStates,
  applyPlantStateSettings,
  composeShader,
  crownInitiation,
  fireSource,
  flameLength,
  flatteningShear,
  floodSource,
  plantStatePoseCode,
  scorchHeight,
  shearVelocity,
} from '../dist/states.js';

import { planCompute } from '../../webgl2-compat/dist/compute.js';

const near = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance * Math.abs(b), `${what}: ${a} vs ${b}`);

test('scorch height is Van Wagner 1973 in its published English-unit form (Albini 1976, BehavePlus)', () => {
  for (const [kw, celsius, wind] of [[100, 25, 0], [300, 25, 2], [2000, 35, 5], [800, 10, 1]]) {
    const btu = kw * 0.288894658, // kW/m to Btu/ft/s
      fahrenheit = celsius * 1.8 + 32,
      mph = wind * 2.23693629,
      feet = (63 / (140 - fahrenheit)) * (btu ** (7 / 6) / Math.sqrt(btu + mph ** 3));
    near(scorchHeight(kw, celsius, wind), feet * 0.3048, 2e-3, `scorch ${kw} kW/m`);
  }
  // Hotter air scorches higher, wind lowers it.
  assert.ok(scorchHeight(500, 35) > scorchHeight(500, 15));
  assert.ok(scorchHeight(500, 25, 6) < scorchHeight(500, 25, 0));
});

test('flame length (Byram 1959), crown initiation (Van Wagner 1977) and flattening (Kouwen and Li 1980)', () => {
  near(flameLength(1000), 0.0775 * 1000 ** 0.46, 1e-12, 'flame');
  near(flameLength(1000), 1.859, 1e-3, 'flame 1 MW/m');
  near(crownInitiation(6, 100), 2475.6, 1e-3, 'I0 for CBH 6 m, FMC 100%');
  assert.equal(crownInitiation(0), 0);
  near(flatteningShear(0.05), 0.028 + 6.33 * 0.0025, 1e-12, 'grass');
  near(flatteningShear(1), 0.23, 1e-12, 'stiff stems take the second branch');
  near(shearVelocity(1, 2, 0.035), 0.035 * 2 * Math.sqrt(9.81), 1e-12, 'u* at 1 m depth');
});

const vertexCodes = (h) =>
  h.pipelines.filter((p) => p.vertex).map((p) => p.vertex.module.code).filter((c) => c.includes('fn scatterPose('));

test('every posing stage reads the map after its own bindings, under the trample edit too', () => {
  const h = optionalGPU(),
    states = PlantStates.create(h.engine, { bounds: [-10, -10, 10, 10], resolution: 8 }),
    effect = new TrampledScatter(box(), { count: 64, material: new PbrMaterial(), states: states.plant() });
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0]) };
  h.context.shader = wgsl;
  h.context.bindings = [];
  h.engine.use(effect);
  h.engine.frameGraph.execute(h.context);
  const pass = h.context.encoder.beginRenderPass({});
  effect.drawShadow({ context: h.context, pass, matrix: h.context.camera.matrix, cascade: 0 });
  effect.prepareShadow({ context: h.context, matrices: new Float32Array(16), cascades: 1 });
  effect.drawShadow({ context: h.context, pass, matrix: h.context.camera.matrix, cascade: 0 });
  const [colour, shadow, list] = vertexCodes(h);
  for (const [code, group, at] of [[colour, 1, 2], [shadow, 0, 2], [list, 0, 3]]) {
    assert.ok(code.includes(`@group(${group}) @binding(${at}) var<storage,read> plantMap:array<vec4f>;`));
    assert.ok(code.includes(`@group(${group}) @binding(${at + 1}) var<uniform> plant:array<vec4f,6>;`));
    assert.ok(code.includes(`@group(${group}) @binding(${at + 2}) var<storage,read> trample:array<vec2f>;`));
    const pose = code.indexOf('fn scatterPose(');
    assert.ok(code.indexOf('let plantC=', pose) > code.indexOf('let push=tramplePush(', pose), 'after the trample turn');
    assert.ok(code.indexOf('let plantC=', pose) < code.indexOf('let bend=windBend(', pose), 'before the wind');
    assert.ok(code.includes('plantOut.normal=plantTurn(plantOut.normal,plantK,plantA)'));
  }
  assert.match(colour, /o\.color=plantColor\(/);
  assert.doesNotMatch(shadow, /plantColor\(material/);
  assert.ok(h.pipelines.some((p) => p.compute?.module.code.includes('var<storage,read_write> map:array<vec4f>')) === false, 'no source, no compose pass');
  effect.dispose();
  states.dispose();
  assert.throws(() => plantStatePoseCode('fn main(){}', 0, 2), TypeError);
});

test('slider rows: shared shape, defaults, looks and apply', () => {
  const names = PLANT_STATE_SETTINGS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const row of PLANT_STATE_SETTINGS) {
    assert.ok(['fire', 'flood', 'ground', 'plant', 'colors'].includes(row.group), row.name);
    assert.equal(row.live, true, row.name);
    assert.ok(typeof row.about === 'string' && row.about.length > 10, row.name);
  }
  const states = new PlantStates({}, { bounds: [-10, -10, 10, 10], resolution: 8 }),
    plant = states.plant();
  for (const row of PLANT_STATE_SETTINGS) {
    const key = row.name.slice(row.name.indexOf('.') + 1);
    if (row.group === 'plant' || row.group === 'colors') assert.deepEqual(plant.response[key], row.default, row.name);
  }
  assert.equal(states.numbers.ambient, 25);
  for (const look of Object.values(PLANT_STATE_LOOKS)) applyPlantStateSettings(states, plant, look);
  applyPlantStateSettings(states, plant, { 'fire.wind': 7, 'plant.crownBase': 5, 'colors.mud': [0.3, 0.2, 0.1] });
  assert.equal(states.numbers.wind, 7);
  assert.equal(plant.response.crownBase, 5);
  assert.deepEqual(plant.response.mud, [0.3, 0.2, 0.1]);
  applyPlantStateSettings(states, plant, {});
  assert.equal(states.numbers.wind, 2, 'a name left out takes its default');
  assert.throws(() => applyPlantStateSettings(states, plant, { 'plant.nope': 1 }), TypeError);
  assert.throws(() => applyPlantStateSettings(states, plant, { 'fire.ambient': 60 }), RangeError);
});

test('options are checked', () => {
  assert.throws(() => new PlantStates({}, { bounds: [0, 0, 0, 1] }), RangeError);
  assert.throws(() => new PlantStates({}, { bounds: [0, 0, 1, 1], resolution: 2048 }), RangeError);
  assert.throws(() => new PlantStates({}, { bounds: [0, 0, 1, 1], fire: {} }), TypeError);
  assert.throws(() => new PlantStates({}, { bounds: [0, 0, 1, 1], ambient: 60 }), RangeError);
  const states = new PlantStates({}, { bounds: [0, 0, 1, 1] });
  assert.throws(() => states.paint([0, 0, 1, 1], [2, 0, 0]), RangeError);
  assert.throws(() => states.plant({ stiffness: 0 }), RangeError);
  assert.throws(() => states.plant({ leaves: 1 }), TypeError);
  states.dispose();
  assert.throws(() => states.plant(), TypeError);
  assert.throws(() => new Scatter(box(), { states: {} }), TypeError);
});

test('sources take a FireFront grid and a Flood terrain rectangle', () => {
  assert.deepEqual(fireSource({ origin: [-5, 2], cell: 2, width: 10, height: 4 }).bounds, [-5, 2, 15, 10]);
  const flood = floodSource({ options: { surface: { options: { terrain: { origin: [1, 2], size: [30, 40] } } } } });
  assert.deepEqual(flood.bounds, [1, 2, 31, 42]);
  assert.throws(() => floodSource({ options: { surface: { options: {} } } }), TypeError);
});

test('the compose pass runs as a GPU draw on the WebGL2 layer, never on its CPU tier', () => {
  // It used to write the map's header from invocation 0 and then read the map: a read after its own store put the
  // whole pass on the layer's JavaScript tier (65,536 cells a frame at the default resolution, with a read-back).
  const plan = planCompute({ source: composeShader, entryPoint: 'main' });
  assert.notEqual(plan.tier, 'cpu', plan.reason);
  assert.equal(plan.tier, 'scatter');
  assert.ok(!/map\[0\]\s*=|map\[1\]\s*=/.test(composeShader), 'the CPU writes the header');
});

/** A device that records queue writes and compute dispatches (with the compose flags of each). */
function recordingDevice() {
  const writes = [],
    dispatches = [];
  let uniform;
  const buffer = (d) => ({ size: d.size, usage: d.usage, destroy() {} });
  const device = {
    createBuffer: (d) => {
      const b = buffer(d);
      if (d.size === 128) uniform = b;
      return b;
    },
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (b, offset, data) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          copy = new Float32Array(bytes.slice().buffer);
        writes.push({ b, offset, data: copy });
      },
    },
  };
  const encoder = () => ({
    clearBuffer() {},
    beginComputePass: () => ({
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups() {
        const last = writes.filter((w) => w.b === uniform).at(-1);
        dispatches.push(new Uint32Array(last.data.buffer)[6]);
      },
      end() {},
    }),
  });
  return { device, encoder, writes, dispatches };
}

test('marks: past burns and flood lines go into layers 4 and 5 and are composed once, again after a reset or a new map', () => {
  const { device, encoder, writes, dispatches } = recordingDevice();
  const states = new PlantStates({}, { bounds: [0, 0, 4, 4], resolution: 4 });
  states.plant({});
  states.mark([0, 0, 2, 2], { scorch: 3, char: 1, intensity: 2.5, ash: 1 });
  states.markEach((x, z) => (x > 3 ? { water: 0.8, debris: 0.5, wetness: 0.25 } : undefined));
  states.compose({ device, encoder: encoder() });
  const n = 16,
    head = 2,
    cpu = writes.filter((w) => w.offset === (head + 3 * n) * 16).at(-1).data;
  assert.equal(cpu.length, 3 * n * 4, 'paint, fire marks and water marks upload together');
  const fire = (c) => Array.from(cpu.subarray((n + c) * 4, (n + c) * 4 + 4)),
    water = (c) => Array.from(cpu.subarray((2 * n + c) * 4, (2 * n + c) * 4 + 4));
  assert.deepEqual(fire(0), [3, 1, 2.5, 1], 'cell (0, 0) centre (0.5, 0.5) is marked');
  assert.deepEqual(fire(5), [3, 1, 2.5, 1]);
  assert.deepEqual(fire(2), [0, 0, 0, 0], 'cell (2, 0) centre (2.5, 0.5) is outside the rectangle');
  assert.deepEqual(water(3), [Math.fround(0.8), 0, 0.5, 0.25], 'markEach marks the last column');
  assert.deepEqual(water(2), [0, 0, 0, 0]);
  assert.deepEqual(dispatches, [16], 'one compose pass with the marks flag and no live source');
  states.compose({ device, encoder: encoder() });
  assert.deepEqual(dispatches, [16], 'the map keeps the marks: no pass while nothing changes');
  states.mark([0, 0, 4, 4], { ash: 0.5 });
  states.compose({ device, encoder: encoder() });
  assert.deepEqual(dispatches, [16, 16], 'a new mark composes again');
  states.reset();
  states.compose({ device, encoder: encoder() });
  assert.deepEqual(dispatches, [16, 16], 'reset forgets the marks');
  states.mark([0, 0, 1, 1], { char: 2 });
  states.compose({ device, encoder: encoder() });
  const other = recordingDevice();
  states.compose({ device: other.device, encoder: other.encoder() });
  assert.deepEqual(other.dispatches, [16], 'a new device (a restore) composes the marks into its fresh map');
  assert.throws(() => states.mark([0, 0, 1, 1], { scorch: -1 }), RangeError);
  assert.throws(() => states.mark([0, 0, 1, 1], { leaves: 1 }), TypeError);
  assert.throws(() => states.markEach(5), TypeError);
  states.dispose();
});

test('PlantStates attaches like every engine feature, and a plant response is a Disposable (KB-ROOT-RED18)', () => {
  const h = optionalGPU(),
    states = PlantStates.attach(h.engine, { bounds: [-10, -10, 10, 10], resolution: 8 });
  assert.ok(states instanceof PlantStates);
  assert.deepEqual(states.resolution, [8, 8]);
  // create stays as the old name of attach.
  assert.deepEqual(PlantStates.create(h.engine, { bounds: [0, 0, 4, 4], resolution: 2 }).resolution, [2, 2]);
  const plant = states.plant({ crownBase: 3 });
  const [, { buffer: uniform }] = plant.entries(h.engine.gpu);
  let destroyed = 0;
  const destroy = uniform.destroy;
  uniform.destroy = () => {
    destroyed++;
    destroy?.call(uniform);
  };
  assert.equal(typeof plant[Symbol.dispose], 'function');
  plant[Symbol.dispose]();
  assert.equal(destroyed, 1, '[Symbol.dispose] frees the response uniform as dispose() does');
  // The map forgot it: disposing the map drops no buffer of the plant again.
  states.dispose();
  assert.equal(destroyed, 1);
});
