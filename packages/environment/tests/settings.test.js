// The settings table of @margoengine/environment/settings: rows are well formed, the defaults written leave the fog's
// uniform and the scene fog, environment and background as they are without options, ranges are enforced, the named looks
// are only row values, a visibility null leaves the weather's density alone, and writing every live row each frame for 60
// frames creates no GPU object. The real-GPU check (frame exact, counted objects, native and the WebGL2 layer) is
// tests/settings.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { VolumetricFog } from '../dist/volumetric.js';
import { EnvironmentBackground, Fog } from '../dist/index.js';
import {
  ENVIRONMENT_LIVE_SETTINGS,
  ENVIRONMENT_LOOKS,
  ENVIRONMENT_SETTINGS,
  applyEnvironmentSettings,
  environmentSettingDefaults,
} from '../dist/settings.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
function rig(options = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    plugins: new Map(),
    lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
    removePlugin() {},
  };
  const target = new SceneTarget(
    gpu.device,
    gpu.device.createTexture({ size, format: 'rgba16float', usage }),
    gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
    1,
  );
  const fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  const frame = (i) => {
    view.begin(i);
    target.begin(view.c);
    const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
    camera.update(16 / 9, true);
    view.c.camera = camera;
    run(view.c);
  };
  return { gpu, fog, frame, record: (work) => gpu.record(work) };
}
// The bytes of the fog's uniform (76 floats) written by the frame: the biggest writeBuffer of it.
const uniform = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 76 * 8).at(-1)?.[3];
const made = (log) => log.filter((e) => /^(renderPipeline|computePipeline|buffer|texture|module)$/.test(e[0])).length;

test('every row is well formed, unique, and live except the grid', () => {
  const names = new Set();
  for (const s of ENVIRONMENT_SETTINGS) {
    assert.ok(!names.has(s.name), s.name);
    names.add(s.name);
    assert.equal(s.live, !s.name.startsWith('grid.'), s.name);
    assert.ok(['number', 'color', 'choice'].includes(s.kind), s.name);
    assert.ok(s.about.length > 10 && typeof s.unit === 'string', s.name);
    if (s.default === null) assert.equal(s.nullable, true, s.name);
    else if (s.kind === 'number') assert.ok(s.default >= s.min && s.default <= s.max, s.name);
  }
  assert.equal(ENVIRONMENT_LIVE_SETTINGS.length, ENVIRONMENT_SETTINGS.length - 3);
  assert.equal(ENVIRONMENT_SETTINGS.find((s) => s.name === 'air.visibility').weather, 'visibility');
  assert.deepEqual(
    Object.keys(environmentSettingDefaults()),
    ENVIRONMENT_SETTINGS.map((s) => s.name),
  );
});

test('the defaults written draw the volumetric fog as it is without options: the same uniform bytes, the same options', () => {
  const a = rig(),
    b = rig({
      visibility: 300,
      heightFalloff: 0.01,
      height: 20,
      ambient: [1, 2, 3],
      anisotropy: -0.4,
      multipleScattering: 90,
      range: 40,
      temporal: 0.3,
      noise: 0.7,
      noiseScale: 3,
      wind: [1, 0, 1],
      enabled: false,
    });
  const plain = uniform(a.record(() => a.frame(0)));
  assert.ok(plain, 'the uniform is written');
  assert.notEqual(uniform(b.record(() => b.frame(0))), plain);
  applyEnvironmentSettings({ air: b.fog });
  assert.deepEqual(Object.keys(b.fog.options), ['wind'], 'only the drift stays: a null wind leaves it');
  assert.equal(uniform(b.record(() => b.frame(0))), plain);
});

test('values land in the fog options; null follows what the weather wrote', () => {
  const { fog } = rig();
  applyEnvironmentSettings(
    { air: fog },
    {
      'air.visibility': 500,
      'air.heightFalloff': 0.005,
      'air.height': 12,
      'air.color': [0.5, 0.5, 0.5],
      'air.ambient': [2, 2, 2],
      'noise.windX': 2,
      'grid.width': 32,
    },
  );
  assert.deepEqual(
    { ...fog.options },
    {
      grid: [32, 90, 64],
      visibility: 500,
      heightFalloff: 0.005,
      height: 12,
      color: [0.5, 0.5, 0.5],
      ambient: [2, 2, 2],
      wind: [2, 0, 0],
    },
  );
  assert.ok(Math.abs(fog.extinction - Math.log(50) / 500) < 1e-12);
  // The weather drive writes `density`; a null visibility leaves it, a value replaces it.
  fog.options.density = 0.01;
  applyEnvironmentSettings({ air: fog }, { 'air.visibility': null, 'noise.windX': null, 'noise.windZ': null });
  assert.equal(fog.options.density, 0.01);
  assert.equal(fog.options.visibility, undefined);
  assert.deepEqual(fog.options.wind, [2, 0, 0], 'a null wind leaves the drift as it was');
  assert.equal(fog.extinction, 0.01);
  applyEnvironmentSettings({ air: fog }, { 'air.visibility': 1000 });
  assert.equal(fog.options.density, undefined);
});

// The colour follows the weather like the visibility (sheet row 8): a WeatherDrive writes the load's colour into
// `color`, so a null row must leave a colour the table did not set, and take back only one it set.
test('air.color follows the weather: null leaves a colour the drive or a person wrote, a value holds it, null releases it', () => {
  const row = ENVIRONMENT_SETTINGS.find((s) => s.name === 'air.color');
  assert.equal(row.default, null);
  assert.equal(row.weather, 'visibility');
  const { fog } = rig();
  fog.options.color = [0.4, 0.4, 0.4];
  applyEnvironmentSettings({ air: fog }, {});
  assert.deepEqual(fog.options.color, [0.4, 0.4, 0.4], 'a colour written outside the table stays');
  const held = Symbol.for('margoengine.weather-held');
  applyEnvironmentSettings({ air: fog }, { 'air.color': [0.2, 0.3, 0.4] });
  assert.deepEqual(fog.options.color, [0.2, 0.3, 0.4]);
  assert.ok(fog.options[held].has('color'), 'a value holds the colour from the weather');
  applyEnvironmentSettings({ air: fog }, { 'air.color': null });
  assert.equal(fog.options.color, undefined, 'null takes back the colour the table set');
  assert.equal(fog.options[held].has('color'), false, 'and hands it back to the weather');
  // A white value is a held white, not an unset colour.
  applyEnvironmentSettings({ air: fog }, { 'air.color': [1, 1, 1] });
  assert.deepEqual(fog.options.color, [1, 1, 1]);
  assert.ok(fog.options[held].has('color'));
});

test('scene fog, environment and background rows land in their setters, and the defaults put them back', () => {
  const fog = new Fog({ near: 5, far: 50, density: 0.02, heightFalloff: 0.1, height: 3, color: [0.1, 0.2, 0.3] }),
    environment = { intensity: 3, rotation: 2 },
    background = new EnvironmentBackground(
      { rotation: 0, device: null, disposed: false, roughnessToLod: () => 0 },
      { exposure: 2, blur: 0.5, rotation: 1 },
    ),
    targets = { fog, environment, background };
  applyEnvironmentSettings(targets);
  // sceneFog.density is null: left as it was. Everything else is back to the object's own defaults.
  const plain = new Fog();
  assert.deepEqual(
    [fog.color, fog.near, fog.far, fog.heightFalloff, fog.height, fog.enabled],
    [[1, 1, 1], plain.near, plain.far, plain.heightFalloff, plain.height, true],
  );
  assert.equal(fog.density, Math.fround(0.02));
  assert.deepEqual([environment.intensity, environment.rotation], [1, 0]);
  assert.deepEqual([background.exposure, background.blur, background.rotation], [1, 0, 0]);
  applyEnvironmentSettings(targets, {
    'sceneFog.density': 0.005,
    'sceneFog.enabled': 'off',
    'sceneFog.far': 400,
    'environment.intensity': 2,
    'environment.rotation': 90,
    'background.exposure': 0.5,
    'background.blur': 0.25,
    'background.rotation': 180,
  });
  assert.equal(fog.density, Math.fround(0.005));
  assert.equal(fog.enabled, false);
  assert.equal(fog.far, 400);
  assert.equal(environment.intensity, 2);
  assert.ok(Math.abs(environment.rotation - Math.PI / 2) < 1e-12);
  assert.deepEqual([background.exposure, background.blur], [0.5, 0.25]);
  assert.ok(Math.abs(background.rotation - Math.PI) < 1e-12);
});

test('values are checked against their rows: unknown names throw TypeError, bad values RangeError', () => {
  const { fog } = rig(),
    targets = { air: fog, fog: new Fog() };
  assert.throws(() => applyEnvironmentSettings(targets, { 'air.nope': 1 }), TypeError);
  for (const s of ENVIRONMENT_SETTINGS) {
    if (s.kind === 'number') {
      assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: s.max + 1 }), RangeError, s.name);
      assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: s.min - 1 }), RangeError, s.name);
      assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: 'x' }), RangeError, s.name);
    } else if (s.kind === 'color') {
      assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: [s.max + 1, 0, 0] }), RangeError, s.name);
      assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: [0, 0] }), RangeError, s.name);
    } else assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: 'maybe' }), RangeError, s.name);
    if (!s.nullable) assert.throws(() => applyEnvironmentSettings(targets, { [s.name]: null }), RangeError, s.name);
    else assert.doesNotThrow(() => applyEnvironmentSettings(targets, { [s.name]: null }), s.name);
  }
  // A grid size is a whole number of froxels; a row whose object is not given is a TypeError once moved.
  assert.throws(() => applyEnvironmentSettings(targets, { 'grid.width': 10.5 }), RangeError);
  assert.throws(() => applyEnvironmentSettings({ fog: new Fog() }, { 'air.visibility': 500 }), TypeError);
  assert.throws(() => applyEnvironmentSettings({ air: fog }, { 'background.blur': 0.5 }), TypeError);
  assert.doesNotThrow(() => applyEnvironmentSettings({ air: fog }, { 'background.blur': 0 }));
});

test('the named looks are only row values, all in range, and each changes the fog', () => {
  const { fog, frame, record } = rig(),
    names = new Set(ENVIRONMENT_SETTINGS.map((s) => s.name)),
    seen = new Set();
  assert.deepEqual(Object.keys(ENVIRONMENT_LOOKS), ['natural', 'clear', 'haze', 'mist', 'fog', 'smokePall', 'dustHaze', 'animatedFeature']);
  for (const [name, values] of Object.entries(ENVIRONMENT_LOOKS)) {
    for (const key of Object.keys(values)) assert.ok(names.has(key), `${name}: ${key}`);
    applyEnvironmentSettings({ air: fog }, values);
    const bytes = uniform(record(() => frame(0)));
    assert.ok(!seen.has(bytes), `${name} differs from the looks before it`);
    seen.add(bytes);
  }
  applyEnvironmentSettings({ air: fog }, ENVIRONMENT_LOOKS.dustHaze);
  assert.ok(Math.abs(fog.extinction - Math.log(50) / 800) < 1e-12, 'dust haze: 800 m');
});

test('writing every live row each frame for 60 frames creates no GPU object and the last frame equals writing once', () => {
  const swept = rig(),
    once = rig(),
    // The rows move between a value away from the default and another; multipleScattering stays off 0 (leaving 0
    // compiles one program) and enabled off for one frame at 30.
    at = (t, i) => {
      const values = {};
      for (const s of ENVIRONMENT_LIVE_SETTINGS) {
        if (s.name.startsWith('environment.') || s.name.startsWith('background.') || s.name.startsWith('sceneFog.'))
          continue;
        if (s.kind === 'color')
          values[s.name] = s.default === null ? [s.max * (0.5 + 0.5 * t), s.max * 0.5, s.max * 0.5] : s.default.map((x) => x * (0.5 + 0.5 * t));
        else if (s.kind === 'choice') values[s.name] = i === 30 ? 'off' : 'on';
        else if (s.name === 'air.multipleScattering') values[s.name] = 100 + 100 * t;
        else if (s.name === 'air.visibility') values[s.name] = 300 + 700 * t;
        else if (s.name === 'air.heightFalloff') values[s.name] = 0.001 + 0.003 * t;
        else if (s.name === 'noise.windX' || s.name === 'noise.windZ') values[s.name] = 1 + t;
        else values[s.name] = s.default + (Math.min(s.max, s.default + (s.max - s.default) * 0.1) - s.default) * t;
      }
      return values;
    };
  // Warm up: the first frames compile what the rows need.
  applyEnvironmentSettings({ air: swept.fog }, at(0, 0));
  assert.ok(
    made(swept.record(() => swept.frame(0))) > 0,
    'the counter sees the first frame make its programs and buffers',
  );
  const log = swept.record(() => {
    for (let i = 0; i < 60; i++) {
      applyEnvironmentSettings({ air: swept.fog }, at(i / 59, i));
      swept.frame(i + 1);
    }
  });
  assert.equal(made(log), 0, 'no pipeline, module, buffer or texture');
  applyEnvironmentSettings({ air: once.fog }, at(1, 59));
  once.record(() => once.frame(0));
  const a = uniform(swept.record(() => swept.frame(61))),
    b = uniform(once.record(() => once.frame(61)));
  assert.equal(typeof a, 'string');
  // Jitter and the temporal weight depend on the frame count, so compare the uniform's look floats: all but the
  // reprojection weight (43), the jitter (68 to 70) and the previous frame's matrices.
  const floats = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);
  const fa = floats(a),
    fb = floats(b);
  for (const i of [44, 45, 46, 47, 48, 49, 50, 51, 55, 56, 57, 58, 59, 60, 61, 62, 63])
    assert.equal(fa[i], fb[i], `float ${i}`);
});

test('a scene fog density or noise wind given a value is held from the weather drive; null hands it back', async () => {
  const { heldFromWeather } = await import('../../shared/settings.js');
  const { applyEnvironmentSettings } = await import('../dist/settings.js');
  const fog = { density: 0, color: [1, 1, 1], near: 0, far: 100, enabled: true, height: 0, heightFalloff: 0 },
    air = { options: {} };
  applyEnvironmentSettings({ fog, air }, { 'sceneFog.density': 0.02, 'noise.windX': 2 });
  assert.equal(heldFromWeather(fog, 'density'), true);
  assert.equal(heldFromWeather(air.options, 'wind'), true);
  applyEnvironmentSettings({ fog, air }, {});
  assert.equal(heldFromWeather(fog, 'density'), false);
  assert.equal(heldFromWeather(air.options, 'wind'), false);
});
