// @margoengine/sky/aerial: options, the atmosphere's parameters and the GPU work on the tracing mock. The air's
// transmittance against Beer-Lambert on the CPU is proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AerialPerspective, EARTH_ATMOSPHERE, atmosphereParameters } from '@margoengine/sky/aerial';
import { Sky } from '@margoengine/sky';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const depthOf = (h, samples = 4) =>
  Object.assign(
    h.engine.gpu.createTexture({
      size: [128, 96],
      format: 'depth32float',
      sampleCount: samples,
      usage: globalThis.GPUTextureUsage.TEXTURE_BINDING,
    }),
    { depthOrArrayLayers: 1 },
  );

test('atmosphere parameters default to Earth and name the field they reject', () => {
  const earth = atmosphereParameters();
  assert.deepEqual(earth, { ...EARTH_ATMOSPHERE });
  assert.deepEqual(earth.rayleigh, [0.005802, 0.013558, 0.0331], 'Hillaire 2020 Table 1');
  assert.equal(atmosphereParameters({ mieG: 0.7 }).mieG, 0.7);
  assert.throws(() => atmosphereParameters({ topRadius: 6000 }), /topRadius/);
  assert.throws(() => atmosphereParameters({ mieG: 1 }), /mieG/);
  assert.throws(() => atmosphereParameters({ rayleigh: [1, -1, 0] }), /rayleigh/);
  assert.throws(() => atmosphereParameters({ mieHeight: 0 }), /mieHeight/);
});

test('aerial perspective needs a depth function and checks its options', () => {
  assert.throws(() => new AerialPerspective(), /needs a depth function/);
  const depth = () => undefined;
  assert.doesNotThrow(() => new AerialPerspective({ depth, maxDistance: 100000, metersPerUnit: 50 }));
  for (const bad of [{ maxDistance: 10 }, { metersPerUnit: 0 }, { altitude: -1 }, { sunIlluminance: -1 }])
    assert.throws(() => new AerialPerspective({ depth, ...bad }), /Invalid AerialPerspective options/, JSON.stringify(bad));
  assert.throws(() => new AerialPerspective({ depth, atmosphere: { mieG: 2 } }), /mieG/);
});

test('aerial perspective builds its tables once, its volume every frame, and draws only over scene depth', () => {
  const h = tracedGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  let depth;
  const sky = new Sky({ hours: 10, timeScale: 0, turbidity: 3 }),
    aerial = new AerialPerspective({ sky, depth: () => depth }),
    writes = [],
    queue = h.engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data) => {
    if (data.length === 48) writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  h.engine.use(sky);
  h.engine.use(aerial);
  const frame = () => {
    sky.onPreUpdate(h.context.delta);
    aerial.onPreUpdate(h.context.delta);
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  };
  frame();
  assert.equal(writes.length, 0, 'no scene depth, no air');
  depth = depthOf(h);
  frame();
  frame();
  const code = [...h.shaders.values()].join('\n');
  assert.match(code, /fn integrateScattering\(/);
  assert.match(code, /@fragment fn transmit\(/);
  assert.match(code, /texture_depth_multisampled_2d/);
  assert.ok(h.created.some((r) => r.startsWith('texture(256,64,rgba16float')), 'transmittance table');
  assert.ok(h.created.some((r) => r.startsWith('texture(32,32,rgba16float')), 'multiple scattering table');
  assert.equal(h.created.filter((r) => r.startsWith('texture(32,32,32,rgba16float')).length, 2, 'scatter and transmittance volumes');
  const v = writes.at(-1);
  // The sky's turbidity 3 scales Mie scattering by (3 - 1) / 2 = 1; the Preetham sky lends illuminance 10.
  assert.equal(v[20], Math.fround(0.003996));
  assert.equal(v[34], 10);
  sky.options.turbidity = 5;
  sky.options.model = 'bruneton';
  frame();
  assert.equal(writes.at(-1)[20], Math.fround(0.003996 * 2));
  assert.equal(writes.at(-1)[34], 20, 'the Bruneton model is built at 20');
  aerial.dispose();
  sky.dispose();
});
