import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky, sunlight } from '../dist/index.js';
import { Sky as BaseSky } from '../dist/base.js';
import { preetham } from '../dist/preetham.js';
import { look, extendSky, EARTH_RAYLEIGH_COLOR, LOOK_FLOATS } from '../dist/look.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

// A harness that records every shader module the sky makes.
function harness() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    module = device.createShaderModule,
    codes = [];
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  device.createShaderModule = (d) => (codes.push(d.code), module.call(device, d));
  // A frame with core's PBR shader in place, which sky ambient lighting extends.
  const frame = () => {
    for (const plugin of h.engine.plugins.values()) plugin.onPreUpdate?.(h.context.delta);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  return { ...h, codes, frame };
}
const uniform = (h) => h.resources.find((r) => !r.destroyed && r.size === 256 + LOOK_FLOATS * 4);

test('the rewrite reaches every anchor of the sky, its night, clouds, fog, reflection, lighting and tables', () => {
  for (const model of ['preetham', 'bruneton'])
    for (const night of [undefined, { moonPhase: 'full' }]) {
      const h = harness(),
        sky = new Sky({ model, night, clouds: {}, environment: true, look: {}, timeScale: 0 });
      h.engine.use(sky);
      h.frame();
      const all = h.codes.join('\n'),
        main = h.codes.find((c) => c.includes('@fragment fn fragment(i:Vertex)') && c.includes('fn lookSky('));
      assert.ok(main, `${model}: the sky's program carries the look`);
      for (const piece of [
        'fn physicalDaySky(',
        'fn physicalNightSky(',
        'SUN_RADIUS*frame.lookSun.w',
        '*(1.0-frame.sun.w)*frame.lookSun.rgb;',
        'thick*3.0*frame.lookCloud.w/',
        '*frame.lookCloud.rgb,opacity);',
        'fn cloudSkyAbove(',
        'fn lowLayer(',
        'lookStops:array<vec4f,8>,air3:vec4f,air4:vec4f,fires:array<vec4f,16>,hazeFires:array<vec4f,16>}',
      ])
        assert.ok(main.includes(piece), `${model}, night ${!!night}: ${piece}`);
      assert.doesNotMatch(all, /\bBETA_R\b/, 'no shader keeps the constant Rayleigh');
      assert.doesNotMatch(all, /fn mie\(\)->f32/, 'no shader keeps the constant Mie');
      if (model === 'bruneton') assert.match(all, /let g=frame\.air1\.w;/, "the tables' Mie phase reads the asymmetry");
      sky.dispose();
      h.cleanup();
    }
  // A shader the rewrite no longer fits fails loudly instead of drawing the physical sky with the look ignored.
  assert.throws(() => extendSky('struct Frame {sunlight:vec4f}', false), /no longer contains/);
});

test('setting the look recompiles once, values move live, and clearing it compiles the original programs again', () => {
  const h = harness(),
    sky = new Sky({ model: 'bruneton', timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const original = [...h.codes];
  h.codes.length = 0;
  h.frame();
  assert.equal(h.codes.length, 0, 'a steady frame compiles nothing');
  sky.options.look = { zenithStrength: 0.5 };
  h.frame();
  const compiled = h.codes.length;
  assert.ok(compiled > 0 && h.codes.every((c) => !/\bBETA_R\b/.test(c)), 'the sky and its tables are compiled again');
  const before = h.counts.compute;
  sky.options.look.zenithStrength = 1;
  sky.options.look.zenithColor = [1, 0, 0];
  h.frame();
  assert.equal(h.codes.length, compiled, 'a new look value compiles nothing');
  assert.equal(h.counts.compute, before, 'and refills no table');
  const block = new Float32Array(uniform(h).data, 256, LOOK_FLOATS);
  assert.deepEqual([...block.subarray(12, 16)], [1, 0, 0, 1], 'zenith colour and strength');
  sky.options.atmosphere = { rayleigh: 2 };
  h.frame();
  assert.ok(h.counts.compute > before, 'new air refills the transmittance and Bruneton tables');
  const refill = h.counts.compute;
  h.frame();
  assert.equal(h.counts.compute, refill, 'steady air refills nothing');
  assert.deepEqual(
    [...new Float32Array(uniform(h).data, 256, 4)],
    [...EARTH_RAYLEIGH_COLOR.map((c) => Math.fround(c * 0.0331 * 2)), 0],
  );
  delete sky.options.look;
  delete sky.options.atmosphere;
  h.codes.length = 0;
  h.frame();
  assert.ok(h.codes.length > 0);
  for (const code of h.codes) assert.ok(original.includes(code), 'cleared: the programs the sky had before');
  sky.dispose();
  h.cleanup();
});

test('the air block, the sun through it and the engine light', () => {
  const air = look.air({}, new Float32Array(9));
  // Earth's air packed: Rayleigh per km, no ozone, grey Mie of 1, asymmetry 0.8, haze amount 1.
  assert.deepEqual([...air], [0.005802, 0.013558, 0.0331, 0, 1, 1, 1, 0.8, 1].map(Math.fround));
  for (const mu of [1, 0.5, 0.1, 0.02, 0]) {
    const plain = sunlight(mu, 0.001, 2),
      through = sunlight(mu, 0.001, 2, new Float32Array(3), air);
    plain.forEach((v, i) => assert.ok(Math.abs(v - through[i]) < 1e-5, `Earth's air is the plain sun at mu ${mu}`));
  }
  // Ozone takes red and green at a low sun; thick Rayleigh reddens it.
  const low = sunlight(0.05, 0.001, 2),
    ozone = sunlight(0.05, 0.001, 2, new Float32Array(3), look.air({ atmosphere: { ozone: 5 } }, new Float32Array(9))),
    thick = sunlight(
      0.05,
      0.001,
      2,
      new Float32Array(3),
      look.air({ atmosphere: { rayleigh: 3 } }, new Float32Array(9)),
    );
  // Ozone's Chappuis band: green loses the most, blue the least.
  const kept = ozone.map((v, i) => v / low[i]);
  assert.ok(kept[1] < 0.5 && kept[2] > kept[0] && kept[0] > kept[1], `ozone ${ozone} against ${low}`);
  assert.ok(thick[2] / thick[0] < 0.5 * (low[2] / low[0]), `thick air reddens the sun: ${thick}`);
  // sunIntensity and sunColor scale the engine light and the sunlight the clouds take.
  const h = harness(),
    sky = new Sky({ timeScale: 0, hours: 12, lighting: { intensity: 3 } });
  h.engine.use(sky);
  h.frame();
  const lit = sky.lights[0].direction[3],
    radiance = [...sky.lights[0].radiance];
  sky.options.atmosphere = { sunIntensity: 2, sunColor: [1, 0.5, 0.5] };
  h.frame();
  assert.ok(Math.abs(sky.lights[0].direction[3] / lit - 2) < 1e-5, 'twice the sun, twice the light');
  assert.ok(Math.abs(sky.lights[0].radiance[1] / sky.lights[0].radiance[0] - 0.5 * (radiance[1] / radiance[0])) < 1e-5);
  sky.dispose();
  h.cleanup();
});

test('look and atmosphere need the look feature and check every value', () => {
  assert.throws(() => new BaseSky({ look: {} }, { preetham }), /look from @margoengine\/sky\/look/);
  assert.throws(() => new BaseSky({ atmosphere: {} }, { preetham }), TypeError);
  assert.doesNotThrow(() => new BaseSky({ look: {}, atmosphere: {} }, { preetham, look }));
  for (const [bad, message] of [
    [{ look: { zenithStrength: 2 } }, /look\.zenithStrength; use a number from 0 to 1/],
    [{ look: { sunDiscSize: 0 } }, /look\.sunDiscSize/],
    [{ look: { glowColor: [1, 1] } }, /look\.glowColor; use three numbers from 0 to 1/],
    [{ look: { gradient: [{ elevation: 0, color: [1, 1, 1] }] } }, /look\.gradient; use 2 to 8 stops/],
    [
      {
        look: {
          gradient: [
            { elevation: 10, color: [1, 1, 1] },
            { elevation: 5, color: [1, 1, 1] },
          ],
        },
      },
      /elevations -90 to 90 degrees rising/,
    ],
    [{ atmosphere: { mieAnisotropy: 1 } }, /atmosphere\.mieAnisotropy; use a number from -0.95 to 0.95/],
    [{ atmosphere: { mieColor: [1, 2, 1] } }, /atmosphere\.mieColor; use three numbers from 0 to 1/],
    [{ atmosphere: { rayleigh: -1 } }, /atmosphere\.rayleigh/],
    [{ atmosphere: 3 }, /Invalid sky atmosphere; pass an object/],
  ])
    assert.throws(() => new Sky(bad), message);
  // Checked every frame too, as every sky option.
  const sky = new Sky({ look: {} });
  sky.options.look.cloudDensity = 9;
  assert.throws(() => sky.advanceTime(0), /look\.cloudDensity/);
});

// KB-LOOK-SKY-SUNSOFT1: the sun disc's edge softness rides the look block (float 31, lookShape.w) and the program widens
// the sun's edge with it; the cloud erosion amount rides the clouds uniform (float 60).
test('the sun disc softness is in the look block and the sun profile reads it; the cloud erosion row is checked', async () => {
  const air = look.air({}, new Float32Array(9)),
    sharp = new Float32Array(LOOK_FLOATS),
    soft = new Float32Array(LOOK_FLOATS);
  look.write(sharp, {}, air);
  look.write(soft, { look: { sunDiscSoftness: 0.6 } }, air);
  assert.equal(sharp[31], 0, 'the default edge is the sharp one');
  assert.equal(soft[31], Math.fround(0.6));
  assert.throws(() => look.validate({ look: { sunDiscSoftness: 1.5 } }), RangeError);
  const h = harness(),
    sky = new Sky({ look: { sunDiscSoftness: 0.5 }, timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const main = h.codes.find((c) => c.includes('fn lookSky('));
  assert.ok(
    main.includes('max(footprint,2.0*SUN_RADIUS*frame.lookSun.w*frame.lookShape.w)'),
    'the sun edge widens with the softness',
  );
  sky.dispose();
  h.cleanup();
  const { VolumetricClouds, writeLayer } = await import('../dist/volumetric-clouds.js');
  const v = new Float32Array(96);
  writeLayer(v, {}, [0, 0, 0]);
  assert.equal(v[60], 1, 'the default erosion is 1');
  writeLayer(v, { erosion: 0.4 }, [0, 0, 0]);
  assert.equal(v[60], Math.fround(0.4));
  assert.throws(() => new VolumetricClouds({ erosion: 2.5 }), RangeError);
  assert.throws(() => new VolumetricClouds({ erosion: -0.1 }), RangeError);
});

// KB-AIR-SKYLIGHT1: the light a low haze layer scatters down (atmosphere.scatteredLight, a share of the zenith sun on
// level ground) rides the look block (floats 72-74, air3) as an even radiance in sky units, the share times the sun's
// strength and the zenith sun on the ground over pi, and the day sky adds it, so the dome, its reflections and the light
// it gives the scene take the layer's glow. The base's uniform holds the whole block (its LOOK_FLOATS is the entry's).
test('the haze layer light rides the look block and the day sky adds it', () => {
  const air = look.air({}, new Float32Array(9)),
    block = new Float32Array(LOOK_FLOATS);
  look.write(block, { atmosphere: { scatteredLight: [0.1, 0.2, 0.3], sunIntensity: 2 } }, air, 5);
  assert.deepEqual(
    [...block.subarray(72, 75)],
    [0.1, 0.2, 0.3].map((v) => Math.fround((v * 2 * 5) / Math.PI)),
  );
  look.write(block, {}, air, 5);
  assert.deepEqual([...block.subarray(72, 76)], [0, 0, 0, 0], 'no layer: no light');
  assert.throws(() => look.validate({ atmosphere: { scatteredLight: [5, 0, 0] } }), /scatteredLight/);
  const h = harness(),
    sky = new Sky({ atmosphere: { scatteredLight: [0.1, 0.1, 0.1] }, timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const u = uniform(h);
  assert.ok(u, `the sky's uniform is 256 bytes and the ${LOOK_FLOATS} floats of the block`);
  const main = h.codes.find((c) => c.includes('fn lookSky('));
  assert.ok(
    main.includes('physicalDaySky(direction)*frame.air2.rgb+frame.air3.rgb'),
    'the day sky adds the layer light',
  );
  assert.ok(
    main.includes('lookStops:array<vec4f,8>,air3:vec4f,air4:vec4f,fires:array<vec4f,16>,hazeFires:array<vec4f,16>}'),
    'the Frame struct ends with the layer light',
  );
  const written = new Float32Array(u.data, 256 + 72 * 4, 3);
  assert.ok(
    written[0] > 0 && written[0] === written[2],
    `the frame writes the layer light from the zenith sun: ${[...written]}`,
  );
  sky.dispose();
  h.cleanup();
});

// KB-SKY-NIGHTPALL1: the night dome drew clear stars under a smoke pall, as the layer reached only the day sky.
test('the night share of the sky and its clouds are seen through the low layer, with its glow in front', () => {
  const air = look.air({}, new Float32Array(9)),
    block = new Float32Array(LOOK_FLOATS);
  look.write(block, {}, air, 5);
  assert.deepEqual([...block.subarray(76, 79)], [1, 1, 1], 'no layer: everything through');
  look.write(block, { atmosphere: { layerTransmittance: [0.5, 0.25, 0.125] } }, air, 5);
  assert.deepEqual([...block.subarray(76, 79)], [0.5, 0.25, 0.125]);
  assert.throws(() => look.validate({ atmosphere: { layerTransmittance: [1.5, 1, 1] } }), /layerTransmittance/);
  const h = harness(),
    sky = new Sky({ atmosphere: { layerTransmittance: [0.1, 0.1, 0.1] }, timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const main = h.codes.find((c) => c.includes('@fragment fn fragment(i:Vertex)') && c.includes('fn lookSky('));
  // Every caller of cloudSky (the sky pass, its reflections and light) now gets the clouds and sky through the layer.
  assert.match(
    main,
    /fn cloudSky\(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32\)->vec3f \{return lowLayer\(cloudSkyAbove\(/,
  );
  assert.equal(main.match(/fn cloudSky\(/g).length, 1, 'one cloudSky, the layered one');
  assert.match(
    main,
    /c\*mix\(vec3f\(1\.0\),t,frame\.sun\.w\)\+frame\.air3\.rgb\*frame\.sun\.w\+fireSky\(w,t\);/,
    "the night share only, the fires' light at every hour (KB-SKY-FIREDAY1)",
  );
  assert.match(main, /max\(w\.y\/max\(length\(w\),1e-6\),0\.052336\)/, 'slant path floored at 3 degrees, as the sun');
  sky.dispose();
  h.cleanup();
});

// KB-SKY-PALLFALLOFF1: the fires' light on a smoke pall was one even glow over the whole dome, so the ridges between did
// not stand out against it. It rides floats 80-143 as up to eight spots, two vec4 each, which lowLayer adds along each
// ray by the cosine law where the ray meets the spot's lit height, no farther across than the sight.
test("the fires' spots on the layer ride the look block and add along each ray", () => {
  const air = look.air({}, new Float32Array(9)),
    block = new Float32Array(LOOK_FLOATS);
  assert.equal(LOOK_FLOATS, 208);
  look.write(block, {}, air, 5);
  assert.ok(
    block.subarray(80).every((v) => v === 0),
    'no fire: nothing written',
  );
  const fireSpots = [
    { color: [0.2, 0.1, 0.05], x: 300, z: -40, height: 1500, reach: 1200 },
    { color: [0.05, 0.02, 0.01], x: -2000, z: 800 },
  ];
  look.write(block, { atmosphere: { fireSpots, fireSight: 2600 } }, air, 5);
  const lit = (c) => c.map((v) => Math.fround((v * 5) / Math.PI));
  assert.deepEqual([...block.subarray(80, 88)], [...lit([0.2, 0.1, 0.05]), 1440000, 300, 1500, -40, 2600]);
  assert.deepEqual([...block.subarray(88, 96)], [...lit([0.05, 0.02, 0.01]), 1e6, -2000, 1000, 800, 0]);
  assert.ok(
    block.subarray(96).every((v) => v === 0),
    'the spots left over end the list',
  );
  const spot = { color: [0.1, 0.1, 0.1], x: 0, z: 0 };
  for (const [bad, what] of [
    [{ fireSpots: Array.from({ length: 9 }, () => spot) }, /at most 8/],
    [{ fireSpots: [{ ...spot, color: [5, 0, 0] }] }, /fireSpots/],
    [{ fireSpots: [{ ...spot, reach: 0 }] }, /fireSpots/],
    [{ fireSpots: [{ ...spot, x: NaN }] }, /fireSpots/],
    [{ fireSpots: {} }, /fireSpots/],
    [{ fireSight: -1 }, /fireSight/],
  ])
    assert.throws(() => look.validate({ atmosphere: bad }), what);
  const h = harness(),
    sky = new Sky({ atmosphere: { fireSpots: [spot] }, timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const main = h.codes.find((c) => c.includes('fn lowLayer(') && c.includes('fn lookSky('));
  assert.ok(main.includes('fn fireLayer(w:vec3f)->vec3f'), 'the fire term');
  assert.ok(main.includes('if(spot.w<=0.0){break;}'), 'the list ends at the first empty spot');
  assert.ok(
    main.includes('light+=spot.rgb*pow(spot.w/(spot.w+dot(across,across)),1.5);'),
    'the cosine law over the squared distance, the spots adding',
  );
  assert.ok(main.includes('if(sight>0.0&&run*flat>sight){run=sight/flat;}'), 'no farther across than the sight');
  sky.dispose();
  h.cleanup();
});

// KB-SKY-HAZEGLOW1: a far ridge the fog hides takes the sky's radiance toward it plus the fog's fire glow on the haze
// (fog.fireSpots, the mean of the falloff along the path's first 2 / density), while the sky over it took the layer's
// glow alone at one point (fireLayer): over a burning valley every hazed ridge stood 6 codes lighter than the sky
// (timber-valley valley-aerial). The haze's spots ride floats 144 to 207 in the sky's units, and lowLayer sees the
// layer's glow through the haze (t) with the haze's own glow in front (1 - t) by the fog's own law.
test("the haze's fire glow is in front of the layer's, by the fog's law", () => {
  const air = look.air({}, new Float32Array(9)),
    block = new Float32Array(LOOK_FLOATS),
    spot = { color: [0.4, 0.2, 0.1], x: 50, z: -1500, reach: 800 };
  look.write(block, { fog: { density: 0.001, fireSpots: [spot] } }, air, 5, 4);
  const f = (x) => Math.fround(x);
  assert.deepEqual([...block.subarray(144, 152)], [f(0.1), f(0.05), f(0.025), 640000, 50, 1000, -1500, 2000]);
  assert.ok(block.subarray(152).every((v) => v === 0), 'the spots left over end the list');
  assert.ok(block.subarray(80, 144).every((v) => v === 0), 'no layer spots written by the fog');
  for (const fog of [{ density: 0, fireSpots: [spot] }, { fireSpots: [] }, undefined]) {
    look.write(block, { fog }, air, 5, 4);
    assert.ok(block.subarray(144).every((v) => v === 0), `no haze glow: ${JSON.stringify(fog)}`);
  }
  // The fog's default density, 0.01: the path end 200 m.
  look.write(block, { fog: { fireSpots: [spot] } }, air, 5);
  assert.equal(block[151], 200);
  const h = harness(),
    sky = new Sky({ atmosphere: { fireSpots: [spot] }, timeScale: 0 });
  h.engine.use(sky);
  h.frame();
  const main = h.codes.find((c) => c.includes('fn lowLayer(') && c.includes('fn lookSky('));
  assert.ok(main.includes('+frame.air3.rgb*frame.sun.w+fireSky(w,t);'), 'the low layer takes the fire term with t');
  assert.ok(main.includes('if(frame.hazeFires[0].w<=0.0){return layer;}'), "without haze spots, the layer's glow alone");
  assert.ok(
    main.includes('return layer*t+(vec3f(1.0)-t)*fireHazeTrack(frame.eye.xz,frame.eye.xz+ray.xz*frame.hazeFires[1].w);'),
    "the layer's glow through the haze, the haze's in front along the fog's path",
  );
  sky.dispose();
  h.cleanup();
});
