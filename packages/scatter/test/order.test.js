// Bug (docs/known-bugs.md, "Apple GPUs: 4x MSAA edges of scatter instances change from frame to frame"): scatter's
// WebGPU cull appended each visible instance at an atomicAdd slot, so its LOD rings held the frame's instances in
// whichever order the GPU's threads happened to run, and on an Apple M6 at 4x MSAA the edge pixels of an instance
// follow that order: a still view drew other pixels every frame. Now each candidate keeps its order (src/order.ts).
// Here a frame's compute passes, as recorded on the stand-in device, run on the WebGL2 layer's CPU tier twice: threads
// in index order, then in reverse (a GPU may run them in any order). The rings must hold the same bytes both times,
// and the same instances the atomic cull gives when its threads run in index order. With the atomic cull the reverse
// run fills every ring backwards.
import test from 'node:test';
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Scatter, scatterCullShader } from '../dist/index.js';
import { ScatterTiles } from '../dist/tiles.js';
import { runComputeOnCPU } from '../../webgl2-compat/dist/compute.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

/**
 * WGSL the CPU tier runs (buffers only): flat ground at height 0 in place of the heightmap, and with `reverse` thread
 * `total - 1 - i` where the GPU would run thread `i`.
 */
function cpuCode(code, total, reverse) {
  code = code
    .replace('@group(0) @binding(1) var terrain:texture_2d<f32>;\n', '')
    .replaceAll('textureDimensions(terrain)', 'vec2u(1u)')
    .replace(/textureLoad\(terrain,.*?,0\)\.r/, '0.0');
  assert.doesNotMatch(code, /terrain/);
  return reverse
    ? code.replace(
        '@builtin(global_invocation_id) id:vec3u){',
        `@builtin(global_invocation_id) thread:vec3u){let id=vec3u(${total - 1}u-thread.x,thread.y,thread.z);`,
      )
    : code;
}

/** The stand-in device with compute passes that run on the CPU tier as they are recorded, and buffers cleared. */
function cpuGPU(reverse) {
  const h = optionalGPU(),
    codes = [];
  h.context.encoder.clearBuffer = (b, offset = 0, size = b.size - offset) =>
    new Uint8Array(b.data, offset, size).fill(0);
  h.context.encoder.beginComputePass = () => {
    let pipeline, group;
    return {
      setPipeline: (p) => (pipeline = p),
      setBindGroup: (_index, g) => (group = g),
      dispatchWorkgroups(x, y = 1) {
        const code = pipeline.compute.module.code,
          size = Number(/@workgroup_size\((\d+)\)/.exec(code)[1]),
          buffers = new Map();
        for (const { binding, resource } of group.entries)
          if (resource.buffer) {
            const offset = resource.offset ?? 0;
            buffers.set(
              `0:${binding}`,
              new Uint8Array(resource.buffer.data, offset, resource.size ?? resource.buffer.size - offset),
            );
          }
        codes.push(code);
        runComputeOnCPU({ source: cpuCode(code, x * size, reverse), workgroups: [x, y], buffers });
      },
      end() {},
    };
  };
  return { h, codes };
}

/** Each ring's instances (8 floats each, as many as its indirect draw names) after one frame. */
function rings(effect) {
  const counts = new Uint32Array(effect.commands.data);
  return [0, 1, 2].map((ring) => new Float32Array(effect.instances[ring].data, 0, counts[ring * 5 + 1] * 8));
}

/** Three meshes (so instances fade between rings) over 50 x 50 m around the stand-in camera at (0, 1, 4). */
const options = { count: 900, area: [50, 50], lod: [12, 24, 120], lodFade: 2 };

test('the cull keeps candidate order whichever order the GPU runs its threads in', () => {
  const frame = (reverse) => {
    const { h, codes } = cpuGPU(reverse),
      effect = new Scatter([box(), box(), box()], options);
    h.engine.use(effect);
    h.frame();
    const out = rings(effect);
    effect.dispose();
    return { out, codes };
  };
  const forward = frame(false),
    reverse = frame(true);
  for (const code of forward.codes) assert.doesNotMatch(code, /atomic/, 'no slot depends on which thread came first');
  const sizes = forward.out.map((r) => r.length / 8);
  assert.ok(
    sizes.every((n) => n > 20),
    `every ring holds instances: ${sizes}`,
  );
  // Fade bands: some instances are in two rings, with rotation.w 1 in the inner one and 2 in the outer one.
  assert.ok(forward.out[0].some((_, k) => k % 8 === 7 && forward.out[0][k] === 1));
  assert.ok(forward.out[1].some((_, k) => k % 8 === 7 && forward.out[1][k] === 2));
  for (let ring = 0; ring < 3; ring++)
    assert.deepEqual(reverse.out[ring], forward.out[ring], `ring ${ring}: the same instances in the same order`);

  // The atomic cull with its threads in index order: the instances the ordered cull must give, in that order.
  const { h } = cpuGPU(false),
    effect = new Scatter([box(), box(), box()], options);
  h.engine.use(effect);
  h.frame();
  const group = h.groups.find((g) =>
      g.entries.some((e) => e.binding === 2 && e.resource.buffer === effect.ordered.candidates),
    ),
    bytes = (binding) => group.entries.find((e) => e.binding === binding).resource.buffer.data,
    near = new Uint8Array(options.count * 32),
    middle = new Uint8Array(options.count * 32),
    far = new Uint8Array(options.count * 32),
    commands = new Uint8Array(60);
  runComputeOnCPU({
    source: cpuCode(scatterCullShader(options), 0, false),
    workgroups: [Math.ceil(options.count / 64)],
    buffers: new Map([
      ['0:0', new Uint8Array(bytes(0))],
      ['0:2', near],
      ['0:3', middle],
      ['0:4', far],
      ['0:5', commands],
      ['0:6', new Uint8Array(bytes(6))],
    ]),
  });
  const counts = new Uint32Array(commands.buffer);
  [near, middle, far].forEach((ring, r) =>
    assert.deepEqual(forward.out[r], new Float32Array(ring.buffer, 0, counts[r * 5 + 1] * 8), `ring ${r}`),
  );
  effect.dispose();
});

test('ScatterTiles: a ring at its capacity keeps the first instances in record order, on any thread order', () => {
  const record = (x, z) => [x & 255, x >> 8, z & 255, z >> 8, 0, 128, 0, 0];
  const frame = (reverse) => {
    const { h } = cpuGPU(reverse),
      tiles = new ScatterTiles(box(), { bounds: [-128, -128, 128, 128], drawn: 5, lod: [100, 200, 300] });
    h.engine.use(tiles);
    // 40 records on a line through the camera's tile, all in the near ring: more than its 5 slots.
    tiles.setTile(
      '0,0',
      [-128, -128],
      256,
      Uint8Array.from(Array.from({ length: 40 }, (_, k) => record(30000 + k * 64, 33000)).flat()),
    );
    h.frame();
    const out = rings(tiles)[0];
    tiles.dispose();
    return out;
  };
  const forward = frame(false),
    reverse = frame(true);
  assert.equal(forward.length / 8, 5, 'the near ring draws its 5 slots');
  assert.deepEqual(reverse, forward);
  // The first five records in order: x grows by one record step (64 / 65536 of the 256 m tile) at a time.
  const xs = Array.from({ length: 5 }, (_, k) => forward[k * 8]);
  assert.deepEqual(
    xs,
    xs.map((_, k) => Math.fround(-128 + ((30000 + k * 64) * 256) / 65536)),
  );
});

// Bug (npm run check:wgsl on Metal): compactShader took any number as its ring, and its WGSL indexes the lanes vector
// (vec4u: candidates, then the three rings' capacities) at ring + 1, so compactShader(4) built a shader that reads
// n[5u] and fails to compile ("index 5 out of bounds [0..3]"). A ring is 0, 1 or 2; anything else throws, and each
// ring's kernel indexes the lanes vector within its four lanes.
test('the ring compaction is built for the three LOD rings only, each within its lanes vector', async () => {
  const dist = new URL('../dist/', import.meta.url),
    chunk = readdirSync(dist).find((f) => /^compat-[\w-]+\.js$/.test(f)),
    { compactShader } = await import(new URL(chunk, dist).href);
  for (const ring of [0, 1, 2]) {
    const code = compactShader(ring),
      lanes = [...code.matchAll(/\bn\[(\d+)u\]/g)].map((m) => Number(m[1]));
    assert.deepEqual(lanes, [ring + 1], `ring ${ring} reads its own capacity`);
    assert.ok(lanes.every((k) => k < 4));
  }
  for (const ring of [3, 4, -1, 1.5, Number.NaN])
    assert.throws(() => compactShader(ring), RangeError, `ring ${ring} is refused`);
});
