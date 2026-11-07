// @margoengine/sky/hillaire: options, the clock, the sun's light through the air on the CPU and the GPU work on the
// tracing mock. The sky's colours from the ground to space are proved on a real GPU by features-check.mjs hillaire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HillaireSky, EARTH_ATMOSPHERE } from '@margoengine/sky/hillaire';
import { AerialPerspective } from '@margoengine/sky/aerial';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const uniformWrites = (h) => {
  const writes = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === 56) writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  return writes;
};

test('the Hillaire sky checks its options and moves its sun by the clock or a direction', () => {
  assert.throws(() => new HillaireSky(null), /must be an object/);
  for (const bad of [
    { exposure: 40 },
    { sunIlluminance: -1 },
    { metersPerUnit: 0 },
    { altitude: -1 },
    { altitude: 2e8 },
    { hours: NaN },
  ])
    assert.throws(() => new HillaireSky(bad), /Invalid HillaireSky options/, JSON.stringify(bad));
  assert.throws(() => new HillaireSky({ sunDirection: [0, 0, 0] }), /nonzero/);
  assert.throws(() => new HillaireSky({ sunDisc: 1 }), /true or false/);
  assert.throws(() => new HillaireSky({ atmosphere: { mieG: 1 } }), /mieG/);
  const sky = new HillaireSky({ hours: 6, timeScale: 1 });
  assert.deepEqual(
    Array.from(sky.sun, (v) => Math.round(v * 1e6) / 1e6),
    [1, 0, 0],
    'sunrise in +x',
  );
  sky.onPreUpdate(6);
  assert.equal(sky.options.hours, 12);
  assert.ok(Math.abs(sky.sun[1] - 1) < 1e-6, 'noon overhead');
  assert.throws(() => sky.onPreUpdate(-1), /delta/);
  const aimed = new HillaireSky({ sunDirection: [0, 3, 4] });
  assert.deepEqual(Array.from(aimed.sun), [0, Math.fround(0.6), Math.fround(0.8)]);
  assert.equal(aimed.sunIlluminance, 20);
  assert.deepEqual(aimed.resolvedAtmosphere, { ...EARTH_ATMOSPHERE });
});

test('the sun reaches the camera through Rayleigh, Mie and ozone: white at noon, red at sunset, none below the ground', () => {
  const h = tracedGPU();
  const sky = new HillaireSky({ sunDirection: [0, 1, 0] });
  h.engine.use(sky);
  h.frame();
  // Straight up from the ground the optical depth is closed form: H_R (1 - e^(-100 / H_R)) for Rayleigh, H_M for Mie
  // (to within e^(-83)) and the ozone tent's area, its half width (Hillaire 2020 Table 1). 256 steps over
  // 100 km keep the exponentials within 1e-4 of it.
  const a = EARTH_ATMOSPHERE;
  for (let c = 0; c < 3; c++) {
    const depth =
      a.rayleigh[c] * a.rayleighHeight * (1 - Math.exp(-100 / a.rayleighHeight)) +
      (a.mie + a.mieAbsorption) * a.mieHeight +
      a.ozone[c] * a.ozoneWidth;
    assert.ok(
      Math.abs(sky.sunTransmittance[c] - Math.exp(-depth)) < 1e-4,
      `channel ${c}: ${sky.sunTransmittance[c]} against ${Math.exp(-depth)}`,
    );
  }
  // One degree above the horizon the light crosses some 26 times the air it crosses overhead: blue is gone and red leads.
  sky.options.sunDirection = [Math.cos(Math.PI / 180), Math.sin(Math.PI / 180), 0];
  h.frame();
  const [r, g, b] = sky.sunTransmittance;
  assert.ok(r > 0.1 && g < r / 3 && b < g / 10, `sunset ${[r, g, b]}`);
  sky.options.sunDirection = [1, -0.1, 0];
  h.frame();
  assert.deepEqual(Array.from(sky.sunTransmittance), [0, 0, 0], 'the planet hides a sun below the horizon');
  // From 1,000 km up the sun the camera sees past the planet's limb crosses no air at all.
  sky.options.altitude = 1e6;
  sky.options.sunDirection = [0, 1, 0];
  h.frame();
  assert.deepEqual(Array.from(sky.sunTransmittance), [1, 1, 1]);
  sky.dispose();
});

test('the Hillaire sky builds its tables once, the sky view every frame inside the air, and draws behind the scene', () => {
  const h = tracedGPU();
  const sky = new HillaireSky({ hours: 17, timeScale: 0, exposure: 1, altitude: 2000 }),
    writes = uniformWrites(h);
  h.engine.use(sky);
  h.frame();
  h.frame();
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /var skyView:texture_storage_2d<rgba16float,write>/);
  assert.match(code, /fn skyViewUV\(/);
  assert.ok(
    h.created.some((r) => r.startsWith('texture(256,64,rgba16float')),
    'transmittance table',
  );
  assert.ok(
    h.created.some((r) => r.startsWith('texture(32,32,rgba16float')),
    'multiple scattering table',
  );
  assert.ok(
    h.created.some((r) => r.startsWith('texture(192,108,rgba16float')),
    'sky-view table',
  );
  const v = writes.at(-1);
  assert.equal(v[39], 2, 'exposure 1 doubles the sky');
  assert.equal(v[34], 20);
  assert.equal(v[47], 1, 'sun disc on by default');
  // The camera stands at y = 0 of the harness; 2 km of altitude puts it 2 km above the 6,360 km ground.
  assert.ok(Math.abs(v[45] - (6360 + 2 + h.engine.camera.position[1] / 1000)) < 1e-3, `eye radius ${v[45]}`);
  const dispatches = () => h.commands().filter((c) => c === 'dispatch 24 27').length;
  const inside = dispatches();
  assert.ok(inside >= 2, 'the sky view is made each frame inside the air');
  sky.options.altitude = 500000;
  h.frame();
  assert.equal(dispatches(), inside, 'from space the sky marches per pixel instead');
  assert.ok(
    h.created.some((c) => c.startsWith('render(') && c.includes('"depthCompare":"greater-equal"')),
    'drawn only where the scene left depth clear',
  );
  sky.dispose();
});

test('aerial perspective takes a Hillaire sky whole: its atmosphere, illuminance, scale and altitude', () => {
  const h = tracedGPU();
  const sky = new HillaireSky({
      hours: 10,
      timeScale: 0,
      sunIlluminance: 30,
      metersPerUnit: 4,
      altitude: 1500,
      atmosphere: { mie: 0.01 },
    }),
    depth = Object.assign(
      h.engine.gpu.createTexture({
        size: [128, 96],
        format: 'depth32float',
        sampleCount: 4,
        usage: globalThis.GPUTextureUsage.TEXTURE_BINDING,
      }),
      { depthOrArrayLayers: 1 },
    ),
    aerial = new AerialPerspective({ sky, depth: () => depth }),
    writes = uniformWrites(h);
  h.engine.use(sky);
  h.engine.use(aerial);
  h.frame();
  const own = writes.filter((v) => v[47] === 0).at(-1);
  // No turbidity rule: the sky's own Mie, not half of it.
  assert.equal(own[20], Math.fround(0.01));
  assert.equal(own[34], 30);
  assert.equal(own[43], Math.fround(0.004));
  assert.ok(Math.abs(own[45] - (6360 + 1.5 + (h.engine.camera.position[1] * 4) / 1000)) < 1e-3);
  aerial.dispose();
  sky.dispose();
});
