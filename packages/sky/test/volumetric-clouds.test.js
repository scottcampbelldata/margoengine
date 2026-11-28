// @margoengine/sky/volumetric-clouds: options, GPU work on the tracing mock, and the wind drift. The pictures are
// proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VolumetricClouds,
  PLANET_RADIUS,
  cloudDeckTransmittance,
  cloudField,
  CLOUD_FLOATS,
  writeVeil,
  layerOf,
} from '@margoengine/sky/volumetric-clouds';
import { Sky } from '@margoengine/sky';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const code = (h) => [...h.shaders.values()].join('\n');
function frame(h, ...plugins) {
  for (const p of plugins) p.onPreUpdate(h.context.delta);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
}

test('volumetric clouds validate their options and name the fix', () => {
  assert.doesNotThrow(() => new VolumetricClouds());
  assert.doesNotThrow(() => new VolumetricClouds({ coverage: 0, bottom: 800, top: 9000, steps: 128, lightSteps: 1 }));
  for (const bad of [
    { coverage: 1.5 },
    { coverage: -0.1 },
    { bottom: 50 },
    { bottom: 3000, top: 2000 },
    { top: 25000 },
    { density: 0 },
    { scale: 10 },
    { steps: 4 },
    { steps: 64.5 },
    { lightSteps: 0 },
    { maxDistance: 10 },
    { evolution: -1 },
  ])
    assert.throws(() => new VolumetricClouds(bad), /Invalid VolumetricClouds options/, JSON.stringify(bad));
  assert.throws(() => new VolumetricClouds({ sunDirection: [0, 0, 0] }), /nonzero length/);
  assert.throws(() => new VolumetricClouds({ sky: {} }), /must be a Sky/);
  assert.throws(() => new VolumetricClouds({ depth: 3 }), /depth must be a function/);
  // Options are read every frame: a bad value set later throws on the next update.
  const clouds = new VolumetricClouds();
  clouds.options.coverage = 2;
  assert.throws(() => clouds.onPreUpdate(0), /Invalid VolumetricClouds options/);
});

test('volumetric clouds make their noise volumes once and ray march one pass per frame', () => {
  const h = tracedGPU(),
    clouds = new VolumetricClouds({ sunDirection: [0.2, 0.8, 0.1] });
  h.engine.use(clouds);
  frame(h, clouds);
  frame(h, clouds);
  assert.ok(
    h.created.some((r) => r.startsWith('texture(64,64,64,rgba8unorm')),
    'shape volume 64^3',
  );
  assert.ok(
    h.created.some((r) => r.startsWith('texture(32,32,32,rgba8unorm')),
    'erosion volume 32^3',
  );
  const wgsl = code(h);
  assert.match(wgsl, /fn shape\(/);
  assert.match(wgsl, /fn erosion\(/);
  assert.match(wgsl, /fn cloudDensityAt\(/);
  assert.match(wgsl, /fn cloudShell\(/);
  assert.equal(h.created.filter((r) => r.startsWith('texture(64,64,64')).length, 1, 'Made once, not per frame');
  assert.ok(cloudField.includes('struct Clouds'));
  clouds.dispose();
});

test('volumetric clouds take their light from a Sky and draw nothing at coverage 0', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 10, timeScale: 0 }),
    clouds = new VolumetricClouds({ sky, coverage: 0 });
  h.engine.use(sky);
  h.engine.use(clouds);
  frame(h, sky, clouds);
  assert.doesNotMatch(code(h), /fn cloudDensityAt\(/, 'Coverage 0 compiles and draws nothing');
  clouds.options.coverage = 0.4;
  frame(h, sky, clouds);
  // The sky's reflection map lights the clouds, reduced on the GPU to light from above and from the horizon.
  assert.match(code(h), /var<workgroup> sums/);
  assert.ok(
    h.created.some((r) => r.startsWith('texture(64,32')),
    'The sky reflection map was asked for',
  );
  clouds.dispose();
  sky.dispose();
});

// KB-CLOUD-DECKLIGHT1 (2026-11-17): the deck lit the scene twice, once through the dimmed engine sun (Sky.deck) and
// again through its sun light laid into the sky's map. The scene's light now takes a second map, the deck without the
// sun and moon the engine lights carry under dimLight; without dimLight their light comes in matched to the engine
// lights, in the sky's units (KB-SKY-SUNUNITS1: the engine sun over Sky.lightScale over 4 pi sunIntensity, and the
// same for the moon over 4 pi 0.15). The ground albedo times
// the deck's share lights the base from below. The light itself is proved on a real GPU (features-check cloud-bounds).
test('the deck lights the scene once: a light-only map, and the sun and moon only where no engine light carries them', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 12, timeScale: 0, lighting: { intensity: 2 } }),
    clouds = new VolumetricClouds({ sky, weather: { cloud: 1 } });
  h.engine.use(sky);
  h.engine.use(clouds);
  frame(h, sky, clouds);
  assert.ok(sky.environmentLayer && sky.environmentLightLayer, 'both maps handed to the sky');
  assert.notEqual(sky.environmentLayer, sky.environmentLightLayer);
  assert.match(code(h), /var deckLight:texture_storage_2d<rgba16float,write>/);
  const v = clouds['values'];
  assert.equal(v[23], Math.fround(0.55), 'the default sun on the clouds');
  assert.equal(v[61], 0, 'dimLight: the engine sun carries the sun under the deck');
  assert.equal(v[62], 0, 'dimLight: the moon under the deck is the engine moon');
  assert.ok(
    Math.abs(v[63] - 0.2 * cloudDeckTransmittance(layerOf(clouds.options), sky.sun[1])) < 1e-6,
    'albedo x share',
  );
  clouds.options.dimLight = false;
  clouds.options.groundAlbedo = 0.8;
  frame(h, sky, clouds);
  // In the sky's units since KB-SKY-SUNUNITS1: the sky's lighting takes the whole map, this layer included, into the
  // engine's by Sky.lightScale (intensity 2 over Preetham's 4 pi 0.55), so the sun's part is the engine sun over that
  // scale (1 at the default sunIntensity) and the moon's 1 over 4 pi 0.15 over it. Before: 2 / (4 pi 0.55) and
  // 1 / (4 pi 0.15), engine units laid into a map that was itself left in sky units.
  assert.ok(Math.abs(sky.lightScale - 2 / (4 * Math.PI * 0.55)) < 1e-9, 'the sky scale');
  assert.ok(Math.abs(v[61] - 1) < 1e-6, 'the sun matched to the engine light, in sky units');
  assert.ok(
    Math.abs(v[62] - Math.fround(0.55 / (0.15 * 2))) < 1e-6,
    'the moon matched to the engine moon, in sky units',
  );
  assert.ok(Math.abs(v[63] - 0.8 * cloudDeckTransmittance(layerOf(clouds.options), sky.sun[1])) < 1e-6);
  for (const groundAlbedo of [-0.1, 1.5, Number.NaN])
    assert.throws(() => new VolumetricClouds({ groundAlbedo }), /groundAlbedo 0 to 1/);
  clouds.dispose();
  assert.equal(sky.environmentLayer, undefined);
  assert.equal(sky.environmentLightLayer, undefined, 'dispose takes the light map back');
  sky.dispose();
});

test('the wind drift wraps at the noise repeat so f32 keeps it exact', () => {
  const clouds = new VolumetricClouds({ wind: [20, -5], evolution: 2, scale: 10000 });
  clouds.onPreUpdate(1000);
  assert.deepEqual([...clouds.drift], [0, -5000, 2000, 20000, -5000]);
  clouds.onPreUpdate(10);
  assert.deepEqual([...clouds.drift], [200, -5050, 2020, 20200, -5050]);
  assert.equal(PLANET_RADIUS, 6_360_000);
});

test('the coverage map drifts on without a jump where the shapes wrap', () => {
  // The coverage map repeats every scale / 0.17 metres. It took the shapes' drift, wrapped at scale, so each wrap moved
  // it back 0.17 of its repeat: the whole sky's cover jumped every scale / wind seconds.
  const h = tracedGPU();
  const clouds = new VolumetricClouds({ wind: [10, 3], scale: 14000 }),
    uniforms = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === CLOUD_FLOATS) uniforms.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  h.engine.use(clouds);
  let seconds = 0;
  for (const delta of [700, 699, 2, 700, 1, 5000]) {
    clouds.onPreUpdate(delta);
    seconds += delta;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
    const v = uniforms.at(-1);
    for (const [axis, wind] of [
      [0, 10],
      [1, 3],
    ]) {
      // Shapes: (p + drift) / scale; coverage map: (p + flags.zw) / scale * 0.17. Each may differ from the unwrapped
      // drift only by whole repeats.
      const shapes = (v[36 + axis] - wind * seconds) / 14000,
        map = ((v[42 + axis] - wind * seconds) / 14000) * 0.17;
      assert.ok(Math.abs(shapes - Math.round(shapes)) < 1e-6, `shapes ${shapes} at ${seconds} s`);
      assert.ok(Math.abs(map - Math.round(map)) < 1e-6, `coverage map ${map} at ${seconds} s`);
    }
  }
  assert.match(code(h), /vec3f\(\(p\.xz\+c\.flags\.zw\+lean\.xz\)\*c\.shape\.x\*0\.17,0\.37\)/);
  clouds.dispose();
});

// KB-SKY-PALLCLOUD1: under a smoke pall the day dome is dimmed and veiled by the layer (sunColor, scatteredLight), and
// the clouds drew over it clean, the brightest thing in a smoke-day frame. They stand above the layer, so they are now
// seen through it (layerTransmittance along the ray) with its glow in front, as the sky draws what is above the layer.
test('a low haze layer in the sky dims and veils the clouds seen through it', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({
      hours: 10,
      timeScale: 0,
      lighting: {},
      atmosphere: { layerTransmittance: [0.3, 0.2, 0.1], sunIntensity: 2, scatteredLight: [0.4, 0.25, 0.1] },
    }),
    clouds = new VolumetricClouds({ sky }),
    uniforms = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === CLOUD_FLOATS) uniforms.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  h.engine.use(sky);
  h.engine.use(clouds);
  frame(h, sky, clouds);
  const v = uniforms.at(-1),
    unit = (2 * sky.zenithSun) / Math.PI;
  assert.ok(sky.zenithSun > 0, `the sky's zenith sun ${sky.zenithSun}`);
  for (const [i, c] of [0.3, 0.2, 0.1, 2].entries()) assert.equal(v[96 + i], Math.fround(c));
  for (const [i, c] of [0.4, 0.25, 0.1].entries()) assert.ok(Math.abs(v[100 + i] - c * unit) < 1e-5 * unit);
  // The picture and both deck maps take the cloud's light through the layer.
  assert.match(code(h), /light=cloudVeiled\(m\.light,m\.opacity,d\);opacity=m\.opacity;/);
  assert.match(code(h), /var color=light\*clouds\.sunColor\.w;/);
  assert.match(code(h), /cloudVeiled\(light,opacity,dir\)\*k/);
  assert.match(code(h), /cloudVeiled\(scene,opacity,dir\)\*k/);
  assert.match(
    code(h),
    /let t=pow\(max\(clouds\.veil\.rgb,vec3f\(1e-30\)\),vec3f\(1\.0\/max\(d\.y\/max\(length\(d\),1e-6\),0\.052336\)\)\);/,
  );
  assert.match(code(h), /return light\*t\*clouds\.veil\.w\+opacity\*\(clouds\.glow\.rgb\+fireSky\(d,t\)\);/);
  clouds.dispose();
  // Without a layer the clouds are as they were: no dimming, no glow, no fires.
  const clear = new Float32Array(CLOUD_FLOATS),
    none = [1, 1, 1, 1, 0, 0, 0, 0, ...new Array(128).fill(0)];
  writeVeil(clear, undefined);
  assert.deepEqual([...clear.subarray(96, 232)], none);
  writeVeil(clear, { sun: [0, 1, 0], options: {}, zenithSun: 6.9 });
  assert.deepEqual([...clear.subarray(96, 232)], none);
});

// KB-SKY-FIREDAY1: the dome draws the fires' light on the smoke layer (atmosphere.fireSpots) in front of what is above it
// at every hour, so clouds above the layer take it in front too, in the same sky units, or each cloud over a burning
// valley is a dark blot on the firelit pall.
test("the fires' light on the layer is in front of the clouds, as of the dome", () => {
  const v = new Float32Array(CLOUD_FLOATS).fill(7),
    spot = { color: [0.2, 0.1, 0.05], x: 300, z: -40, height: 1500, reach: 1200 };
  writeVeil(v, {
    sun: [0, 1, 0],
    options: { atmosphere: { sunIntensity: 2, fireSpots: [spot], fireSight: 2600 } },
    zenithSun: 5,
  });
  const unit = (2 * 5) / Math.PI,
    f = (x) => Math.fround(x);
  assert.deepEqual(
    [...v.subarray(104, 112)],
    [f(0.2 * unit), f(0.1 * unit), f(0.05 * unit), 1440000, 300, 1500, -40, 2600],
  );
  assert.ok(
    v.subarray(112, 232).every((x) => x === 0),
    'the spots left over end the list',
  );
  const h = tracedGPU(),
    sky = new Sky({ hours: 10, timeScale: 0, atmosphere: { fireSpots: [spot] } }),
    clouds = new VolumetricClouds({ sky });
  h.engine.use(sky);
  h.engine.use(clouds);
  frame(h, sky, clouds);
  const c = code(h);
  assert.match(
    c,
    /fires:array<vec4f,16>,hazeFires:array<vec4f,16>,ground:array<vec4f,16>,mist:vec4f,lift:vec4f,link:vec4f,linkGlow:vec4f\}/,
    'the uniform holds the spots',
  );
  assert.ok(c.includes('fn fireLayer(w:vec3f)->vec3f'), "the dome's fire term");
  assert.ok(c.includes('let sight=clouds.fires[1].w;'), 'read from the clouds uniform');
  clouds.dispose();
});

// KB-SKY-HAZEGLOW1: the fog adds its fires' glow on the haze (fog.fireSpots) to a far ground by its own law, which the
// sky's rays did not take, so a ridge the haze hid stood lighter than the sky over it. Clouds over the layer take the
// haze's glow in front as the dome does: the sky's fog spots ride floats 168 to 231 in sky units, the path end 2 / density.
test("the haze's fire glow is in front of the clouds, as of the dome", () => {
  const v = new Float32Array(CLOUD_FLOATS).fill(7),
    spot = { color: [0.4, 0.2, 0.1], x: 50, z: -1500, reach: 800 };
  writeVeil(v, {
    sun: [0, 1, 0],
    options: { exposure: 1, fog: { density: 0.002, fireSpots: [spot] } },
    zenithSun: 5,
    pictureScale: 0.5,
  });
  const f = (x) => Math.fround(x);
  // 2^1 x 0.5 = 1: the fog's units are the sky's here; the path end 2 / 0.002 = 1000 m.
  assert.deepEqual([...v.subarray(168, 176)], [f(0.4), f(0.2), f(0.1), 640000, 50, 1000, -1500, 1000]);
  assert.ok(
    v.subarray(176, 232).every((x) => x === 0),
    'the spots left over end the list',
  );
  writeVeil(v, { sun: [0, 1, 0], options: { exposure: 2, fog: { density: 0.002, fireSpots: [spot] } }, zenithSun: 5 });
  assert.equal(v[168], f(0.1), 'the fog adds after the exposure, the sky before it');
  for (const fog of [{ density: 0, fireSpots: [spot] }, { density: 0.002 }, undefined]) {
    writeVeil(v, { sun: [0, 1, 0], options: { fog }, zenithSun: 5 });
    assert.ok(
      v.subarray(168, 232).every((x) => x === 0),
      `no haze glow: ${JSON.stringify(fog)}`,
    );
  }
  const h = tracedGPU(),
    sky = new Sky({ hours: 10, timeScale: 0, atmosphere: { fireSpots: [spot] } }),
    clouds = new VolumetricClouds({ sky });
  h.engine.use(sky);
  h.engine.use(clouds);
  frame(h, sky, clouds);
  const c = code(h);
  assert.ok(c.includes('fn fireHazeTrack(start:vec2f,end:vec2f)->vec3f'), "the haze's law");
  assert.ok(
    c.includes(
      'return layer*t+(vec3f(1.0)-t)*fireHazeTrack(clouds.eye.xz,clouds.eye.xz+ray.xz*clouds.hazeFires[1].w);',
    ),
    "the layer's glow through the haze, the haze's in front",
  );
  clouds.dispose();
});
