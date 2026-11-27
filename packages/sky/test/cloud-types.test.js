// @margoengine/sky/volumetric-clouds: cloud types from a weather state and the light a deck passes (CPU only).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudLayerFor,
  cloudTypeWeights,
  cloudTransmission,
  cloudDeckTransmittance,
} from '@margoengine/sky/volumetric-clouds';

test('fair weather is cumulus: cover up to half, base 1,000 to tops 2,500 m', () => {
  const w = cloudTypeWeights({ cloud: 0.4 }),
    layer = cloudLayerFor({ cloud: 0.4 });
  assert.deepEqual(w, { cumulus: 1, stratus: 0, storm: 0 });
  assert.equal(layer.coverage, 0.4);
  assert.equal(layer.bottom, 1000);
  assert.equal(layer.top, 2500);
  assert.equal(cloudLayerFor({ cloud: 0.5 }).coverage, 0.5);
});

test('an overcast sky with no rain is stratus: 300 to 900 m, all cover', () => {
  const layer = cloudLayerFor({ cloud: 1 });
  assert.equal(layer.coverage, 1);
  assert.equal(layer.bottom, 300);
  assert.equal(layer.top, 900);
  assert.ok(layer.density >= 0.02 && layer.density <= 0.1);
});

test('rain or lightning under a full sky is a storm: 600 to 8,000 m, the densest cloud', () => {
  for (const weather of [
    { cloud: 1, rain: 1 },
    { cloud: 1, lightning: 1 },
  ]) {
    const layer = cloudLayerFor(weather);
    assert.equal(layer.bottom, 600);
    assert.equal(layer.top, 8000);
    assert.equal(layer.density, 0.1);
    assert.equal(layer.coverage, 1);
  }
});

test('types blend continuously: the weights add to 1 and every layer value stays between the types', () => {
  let previous;
  for (let rain = 0; rain <= 1.0001; rain += 0.05) {
    const state = { cloud: 0.9, rain: Math.min(rain, 1), lightning: 0 },
      w = cloudTypeWeights(state),
      layer = cloudLayerFor(state);
    assert.ok(Math.abs(w.cumulus + w.stratus + w.storm - 1) < 1e-12);
    assert.ok(layer.top >= 900 && layer.top <= 8000 && layer.bottom >= 300 && layer.bottom <= 600);
    if (previous) assert.ok(layer.top >= previous.top, 'tops rise with the rain');
    assert.ok(previous === undefined || Math.abs(layer.top - previous.top) < 1500, 'no jump between steps');
    previous = layer;
  }
  assert.throws(() => cloudLayerFor({ cloud: 2 }), RangeError);
  assert.throws(() => cloudLayerFor({ cloud: 0.5, rain: -1 }), RangeError);
});

test('the two-stream bound: T = 1 / (1 + tau (1 - g) / 2), g 0.85', () => {
  assert.ok(Math.abs(cloudTransmission(0) - 1) < 1e-12);
  for (const [tau, t] of [
    [5, 0.7273],
    [20, 0.4],
    [80, 0.1429],
  ])
    assert.ok(Math.abs(cloudTransmission(tau) - t) < 1e-3, `tau ${tau}`);
  assert.throws(() => cloudTransmission(-1), RangeError);
});

test('a deck passes its share: overcast stratus 40 to 50 percent, a storm 5 percent, a clear sky all', () => {
  const stratus = cloudDeckTransmittance(cloudLayerFor({ cloud: 1 }), 1),
    storm = cloudDeckTransmittance(cloudLayerFor({ cloud: 1, rain: 1 }), 1);
  assert.ok(stratus > 0.4 && stratus < 0.5, String(stratus));
  assert.ok(storm > 0.03 && storm < 0.07, String(storm));
  assert.equal(cloudDeckTransmittance({ coverage: 0, bottom: 1000, top: 2500, density: 0.04 }, 1), 1);
  assert.equal(cloudDeckTransmittance(cloudLayerFor({ cloud: 1 }), 0), 1, 'a light on the horizon is left alone');
  // A low light crosses more cloud.
  assert.ok(cloudDeckTransmittance(cloudLayerFor({ cloud: 1 }), 0.25) < stratus);
  // Half the sky covered passes more than the whole.
  assert.ok(cloudDeckTransmittance({ ...cloudLayerFor({ cloud: 1 }), coverage: 0.5 }, 1) > stratus);
});

// The plugin side: the weather option, the step cap and temporal 'auto' in the uniform, and the sky's deck hook.
import { VolumetricClouds, layerOf, CLOUD_FLOATS } from '@margoengine/sky/volumetric-clouds';
import { Sky } from '@margoengine/sky';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

function harness(options) {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 10, timeScale: 0, lighting: {} }),
    clouds = new VolumetricClouds({ sky, ...options }),
    uniforms = [];
  const write = h.engine.gpu.queue.writeBuffer.bind(h.engine.gpu.queue);
  h.engine.gpu.queue.writeBuffer = (b, offset, v, ...rest) => {
    if (v instanceof Float32Array && v.length === CLOUD_FLOATS) uniforms.push(v.slice());
    return write(b, offset, v, ...rest);
  };
  h.engine.use(sky);
  h.engine.use(clouds);
  const frame = (delta = 1 / 30) => {
    sky.onPreUpdate(delta);
    clouds.onPreUpdate(delta);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
    return uniforms.at(-1);
  };
  return { h, sky, clouds, frame };
}

test('a forced type overrides the weather pick, in the layer and in the options', () => {
  const sunny = { cloud: 0.3 };
  assert.deepEqual(cloudLayerFor(sunny, undefined, 'storm'), { coverage: 1, bottom: 600, top: 8000, density: 0.1 });
  assert.deepEqual(cloudLayerFor(sunny, undefined, 'stratus'), { coverage: 0.3, bottom: 300, top: 900, density: 0.08 });
  assert.deepEqual(cloudLayerFor({ cloud: 1, rain: 1 }, undefined, 'cumulus'), {
    coverage: 0.5,
    bottom: 1000,
    top: 2500,
    density: 0.03,
  });
  assert.deepEqual(
    layerOf({ weather: { cloud: 1, rain: 1 }, type: 'cumulus' }),
    cloudLayerFor({ cloud: 1 }, undefined, 'cumulus'),
  );
  assert.deepEqual(
    layerOf({ type: 'storm' }),
    { coverage: 1, bottom: 600, top: 8000, density: 0.1 },
    'a type needs no weather',
  );
  assert.equal(layerOf({ type: 'storm', top: 5000 }).top, 5000, 'a value set still wins');
  assert.throws(() => cloudLayerFor(sunny, undefined, 'cirrus'), RangeError);
  assert.throws(() => new VolumetricClouds({ type: 'cirrus' }), RangeError);
});

test('the weather option picks the layer for each value left unset, and validates', () => {
  assert.deepEqual(layerOf({ weather: { cloud: 1 } }), cloudLayerFor({ cloud: 1 }));
  assert.equal(layerOf({ weather: { cloud: 1 }, coverage: 0.7 }).coverage, 0.7);
  assert.deepEqual(layerOf({}), { coverage: 0.5, bottom: 1500, top: 4000, density: 0.04 });
  const out = { coverage: 0, bottom: 0, top: 0, density: 0 };
  assert.equal(layerOf({ weather: { cloud: 1, rain: 1 } }, out), out, 'the out value is filled and returned');
  assert.equal(out.top, 8000);
  assert.throws(() => new VolumetricClouds({ weather: { cloud: 3 } }), RangeError);
  assert.throws(() => new VolumetricClouds({ stepCap: 5 }), /stepCap 10 to 10000/);
  assert.throws(() => new VolumetricClouds({ temporal: 'yes' }), /true, false or 'auto'/);
  assert.throws(() => new VolumetricClouds({ dimLight: 1 }), /dimLight must be true or false/);
});

test('the march takes the step cap from the uniform and spaces its steps by a power law under it', () => {
  const { h, clouds, frame } = harness({ stepCap: 250 });
  const v = frame();
  assert.equal(v[51], 250, 'stepCap in moonColor.w');
  const wgsl = [...h.shaders.values()].join('\n');
  assert.match(wgsl, /fn cloudStepPower\(/);
  assert.match(wgsl, /cloudStepPower\(span,nf,clouds\.moonColor\.w\)/);
  clouds.options.stepCap = undefined;
  assert.equal(frame()[51], 150, 'default 150 m');
  // The weather's layer reaches the uniform: base, tops, cover and density of a storm.
  clouds.options.weather = { cloud: 1, rain: 1 };
  const storm = frame();
  assert.deepEqual([storm[28], storm[29], storm[30]], [600, 8000, 1]);
  assert.ok(Math.abs(storm[31] - 0.1) < 1e-7);
  clouds.dispose();
});

test("temporal 'auto' moves the march start only when the scene has TAA", () => {
  const { h, clouds, frame } = harness({ coverage: 0.5 });
  frame();
  const a = frame()[41],
    b = frame()[41];
  assert.equal(a, 0);
  assert.equal(b, 0, 'no TAA: the start stays put');
  h.engine.use({ name: 'taa', setup() {}, registerPasses() {} });
  const c = frame()[41],
    d = frame()[41];
  assert.ok(c > 0 && d > 0 && c !== d, `TAA: the start moves (${c}, ${d})`);
  clouds.options.temporal = false;
  assert.equal(frame()[41], 0, 'false wins over TAA');
  clouds.dispose();
});

test('the deck dims the sky sun and its moonlight under the cloud by cloudDeckTransmittance, and lets go', () => {
  const plain = new Sky({ hours: 10, timeScale: 0, lighting: {} }),
    ph = tracedGPU();
  ph.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  ph.engine.use(plain);
  plain.onPreUpdate(1 / 30);
  const clear = plain.lights[0].direction[3];
  const { sky, clouds, frame } = harness({ weather: { cloud: 1 } });
  assert.equal(sky.deck !== undefined, true, 'the clouds hand the sky their deck');
  frame();
  const want = cloudDeckTransmittance(cloudLayerFor({ cloud: 1 }), sky.sun[1]);
  assert.ok(want < 0.6 && want > 0.3, String(want));
  assert.ok(
    Math.abs(sky.lights[0].direction[3] / clear - want) < 1e-5,
    `${sky.lights[0].direction[3] / clear} vs ${want}`,
  );
  clouds.options.dimLight = false;
  frame();
  assert.ok(Math.abs(sky.lights[0].direction[3] - clear) < 1e-6 * clear, 'dimLight false leaves the sun');
  clouds.options.dimLight = true;
  clouds.options.coverage = 0;
  frame();
  assert.ok(Math.abs(sky.lights[0].direction[3] - clear) < 1e-6 * clear, 'no cover, no dimming');
  clouds.dispose();
  assert.equal(sky.deck, undefined, 'dispose takes the deck back');
  plain.dispose();
});

test('at night the deck sets the moonlight under the cloud in place of the cover rule', () => {
  const { sky, clouds, frame } = harness({ weather: { cloud: 1, rain: 1 } });
  sky.options.hours = 23;
  sky.options.lighting = { moon: {} };
  frame();
  const above = sky.lights[1].direction[3],
    below = sky.moonUnderClouds.direction[3];
  assert.ok(above > 0, 'the moon is up');
  const share = cloudDeckTransmittance(cloudLayerFor({ cloud: 1, rain: 1 }), sky.moon[1]);
  // The colour under the cloud follows the level (moonlightColor), so compare illuminance: intensity x luminance.
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const ratio = (below * lum(sky.moonUnderClouds.radiance)) / (above * lum(sky.lights[1].radiance));
  assert.ok(Math.abs(ratio - share) < 1e-4, `${ratio} vs ${share}`);
  clouds.dispose();
});
