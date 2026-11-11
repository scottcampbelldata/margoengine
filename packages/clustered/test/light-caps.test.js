import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered, MAX_CLUSTERED_LIGHTS } from '../dist/index.js';
import { AreaLights, MAX_AREA_LIGHTS, MAX_AREA_LIGHTS_LIMIT } from '../dist/area.js';
import { LocalShadows } from '../dist/shadows.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const point = (i) => ({ position: [i % 50, 1, Math.floor(i / 50)], range: 2, intensity: 1 + i, color: [1, 0.5, 0.25] });
const rect = (i) => ({ position: [i, 3, 0], direction: [0, -1, 0], width: 0.5, height: 0.5, intensity: 1 + i });

function frames(h, lights) {
  h.engine.use(lights);
  return () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return h.context.shader;
  };
}
const lightBuffer = (lights) => lights.bindings().find((b) => b.binding === 5).resource.buffer;

test('maxLights: 1 to 65,536, default 1,024, and setLights refuses more than the cap', () => {
  assert.equal(MAX_CLUSTERED_LIGHTS, 65536);
  for (const maxLights of [0, 1.5, 65537, Number.NaN, '8'])
    assert.throws(() => new Clustered({ maxLights }), RangeError, String(maxLights));
  assert.equal(new Clustered().maxLights, 1024);
  assert.throws(
    () => new Clustered().setLights(Array.from({ length: 1025 }, (_, i) => point(i))),
    /at most 1,024 lights/,
  );
  const two = new Clustered({ maxLights: 2 });
  assert.throws(() => two.setLights([point(0), point(1), point(2)]), /at most 2 lights/);
  assert.equal(new Clustered({ maxLights: 65536 }).maxLights, 65536);
});

test('the light buffer grows in pages of 1,024 lights and uploads every light, the default staying one page', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2], maxLights: 5000 }),
    frame = frames(h, lights);
  try {
    lights.setLights([point(0)]);
    const first = frame(),
      page = lightBuffer(lights);
    assert.equal(page.size, 1024 * 64, 'one page until more lights come');
    const list = Array.from({ length: 2500 }, (_, i) => point(i));
    lights.setLights(list);
    assert.equal(frame(), first, 'the shader does not depend on the count');
    const grown = lightBuffer(lights),
      floats = new Float32Array(grown.data);
    assert.equal(grown.size, 3 * 1024 * 64);
    assert.ok(page.destroyed, 'the old page is released');
    for (const i of [0, 1023, 1024, 2499])
      assert.deepEqual([...floats.subarray(i * 16, i * 16 + 8)], [...list[i].position, 2, 1, 0.5, 0.25, 1 + i]);
    // The culling uniform counts all of them.
    const uniform = lights.bindings().find((b) => b.binding === 4).resource.buffer;
    assert.equal(new Uint32Array(uniform.data)[19], 2500);
    // Fewer lights keep the pages; a cluster grid group and the receivers' bindings follow the new buffer.
    lights.setLights(list.slice(0, 10));
    frame();
    assert.equal(lightBuffer(lights), grown);
    assert.ok(h.context.bindings.some((b) => b.binding === 5 && b.resource.buffer === grown));
  } finally {
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('lights past 1,024 keep their integrated shadow slots', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2], maxLights: 2048, shadows: { maxLights: 2, resolution: 64 } }),
    frame = frames(h, lights);
  try {
    const list = Array.from({ length: 1500 }, (_, i) => point(i));
    list[1400] = { ...point(1400), shadow: true };
    lights.setLights(list);
    frame();
    const floats = new Float32Array(lightBuffer(lights).data);
    assert.equal(floats[1400 * 16 + 15], 1, 'the 1,401st light holds shadow slot 1');
    assert.equal(floats[1399 * 16 + 15], 0);
  } finally {
    lights.dispose();
  }
});

test('AreaLights maxLights: 1 to 1,024, sizes the light array and moves the LTC table after it', () => {
  const owner = new Clustered({ grid: [2, 2, 2] });
  for (const maxLights of [0, 2.5, MAX_AREA_LIGHTS_LIMIT + 1])
    assert.throws(() => new AreaLights({ lights: owner, maxLights }), RangeError);
  assert.equal(new AreaLights({ lights: owner }).maxLights, MAX_AREA_LIGHTS);
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] }),
    frame = frames(h, lights),
    area = new AreaLights({ lights, maxLights: 300 });
  h.engine.use(area);
  try {
    assert.throws(() => area.setLights(Array.from({ length: 301 }, (_, i) => rect(i))), /at most 300 area lights/);
    area.setLights(Array.from({ length: 300 }, (_, i) => rect(i)));
    const shader = frame();
    assert.match(shader, /lights:array<AreaLight,300>,lut:array<u32>/);
    const buffer = area.bindings()[0].resource.buffer,
      words = new Uint32Array(buffer.data),
      floats = new Float32Array(buffer.data);
    assert.equal(words[0], 300);
    assert.deepEqual([...floats.subarray(4 + 299 * 16, 4 + 299 * 16 + 3)], [299, 3, 0]);
    const lut = 4 + 300 * 16;
    assert.ok(
      words.subarray(lut).some((v) => v !== 0),
      'LTC table after the 300 lights',
    );
    assert.equal(buffer.size, lut * 4 + (words.length - lut) * 4);
    // A casting light past the first 64 is refused: LocalShadows keeps shadow data for those only.
    const list = Array.from({ length: 70 }, (_, i) => rect(i));
    list[64] = { ...rect(64), castShadow: true };
    assert.throws(() => area.setLights(list), /first 64 area lights may cast shadows/);
    list[64] = rect(64);
    list[63] = { ...rect(63), castShadow: true };
    area.setLights(list);
  } finally {
    area.dispose();
    lights.dispose();
  }
});

test('area light shadows read no slot for a light past the first 64 (regression: WGSL clamped j to 63)', () => {
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] }),
    frame = frames(h, lights),
    local = new LocalShadows({ lights, resolution: 64 }),
    area = new AreaLights({ lights, maxLights: 100 });
  h.engine.use(local);
  h.engine.use(area);
  try {
    const list = Array.from({ length: 100 }, (_, i) => rect(i));
    list[63] = { ...rect(63), castShadow: true, shadow: { far: 20 } };
    area.setLights(list);
    const shader = frame();
    // Without the guard, area light 64 and later read area[64 + k], the shape lights' shadow entries (or, past 127,
    // area[127] by index clamping), and took another light's shadow.
    assert.match(
      shader,
      /fn clusterAreaShadow\(j:u32,[^)]*\)->f32 \{if\(j>=64u\)\{return 1\.0;\}return localAreaVisibility\(j,/,
    );
  } finally {
    area.dispose();
    local.dispose();
    lights.dispose();
  }
});

test('setup makes its GPU objects in the order the clustered proofs pin, the light page second', () => {
  // e68bbe3ce made the light buffer after the cluster lists and the pipeline, and set local shadows up before the
  // culling group: every later GPU call of a default scene changed identity (proofs clustered-*, 2026-11-10).
  for (const shadows of [undefined, { maxLights: 2, resolution: 64 }]) {
    const h = optionalGPU(),
      gpu = h.engine.gpu,
      log = [];
    for (const name of ['createBuffer', 'createTexture', 'createBindGroup', 'createComputePipeline']) {
      const make = gpu[name].bind(gpu);
      gpu[name] = (descriptor) => {
        log.push(name === 'createBuffer' ? `buffer ${descriptor.size}` : name);
        return make(descriptor);
      };
    }
    const lights = new Clustered({ grid: [2, 2, 2], ...(shadows ? { shadows } : {}) });
    try {
      lights.setup(h.engine);
      assert.deepEqual(log.slice(0, 6), [
        'buffer 128',
        `buffer ${1024 * 64}`,
        `buffer ${8 * 4}`,
        `buffer ${8 * 1024 * 4}`,
        'createComputePipeline',
        'createBindGroup',
      ]);
      assert.equal(log.length > 6, !!shadows, 'local shadows make theirs after the culling group');
    } finally {
      lights.dispose();
    }
  }
});
