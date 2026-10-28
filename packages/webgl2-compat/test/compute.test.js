// Milestone M5 in Node: the tier analysis (fragment, scatter, CPU) on small shaders and on every compute entry point
// of the WGSL corpus, and the CPU tier's semantics (f32 rounding, WGSL integer rules, atomics, barriers, pointers,
// copies of composite values) against values worked out by hand. The GPU tiers run in compute-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCompute, runComputeOnCPU } from '../dist/compute.js';
import { checkWGSL } from '../dist/wgsl.js';
import { readCorpus } from './corpus/store.mjs';

const tierOf = (source, entryPoint) => planCompute({ source, entryPoint });

test('own-texel stores take the fragment tier, other stores the scatter tier, atomics and barriers the CPU', () => {
  const own = tierOf(`@group(0) @binding(0) var t: texture_storage_2d_array<rgba16float, write>;
    @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
      let p = vec2i(id.xy);
      textureStore(t, p, id.z, vec4f(1.0));
    }`);
  assert.equal(own.tier, 'fragment');
  assert.deepEqual(own.workgroupSize, [8, 8, 1]);
  assert.deepEqual(
    own.targets.map((t) => [t.kind, t.name, t.stores]),
    [['texture', 't', 1]],
  );
  const mirrored = tierOf(`@group(0) @binding(0) var t: texture_storage_2d<r32float, write>;
    @compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(t, vec2u(7u - id.x, id.y), vec4f(1.0)); }`);
  assert.equal(mirrored.tier, 'scatter');
  assert.match(mirrored.reason, /texels other than its own/);
  const words = tierOf(`struct V { a: vec4f, b: vec3f, c: u32 }
    @group(0) @binding(0) var<storage, read_write> out: array<V>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
      for (var i = 0u; i < 3u; i++) { out[id.x * 3u + i] = V(vec4f(1.0), vec3f(2.0), i); }
    }`);
  assert.equal(words.tier, 'scatter');
  assert.equal(words.targets[0].stores, 24, 'three stores of 8 data words (padding is not written)');
  const atomics = tierOf(`@group(0) @binding(0) var<storage, read_write> n: atomic<u32>;
    @compute @workgroup_size(1) fn main() { atomicAdd(&n, 1u); }`);
  assert.equal(atomics.tier, 'cpu');
  const unbounded = tierOf(`@group(0) @binding(0) var<storage, read_write> out: array<u32>;
    @group(0) @binding(1) var<uniform> n: u32;
    @compute @workgroup_size(1) fn main() { for (var i = 0u; i < n; i++) { out[i] = i; } }`);
  assert.equal(unbounded.tier, 'cpu');
  assert.match(unbounded.reason, /loop of unknown length/);
  const readBack = tierOf(`@group(0) @binding(0) var<storage, read_write> out: array<u32>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) { out[id.x] = 1u; out[id.x] += 1u; }`);
  assert.equal(readBack.tier, 'cpu');
  assert.match(readBack.reason, /reads back/);
});

test('every compute entry point of the corpus gets a tier (none is refused)', () => {
  const { modules } = readCorpus();
  const tiers = { fragment: 0, scatter: 0, cpu: 0 };
  for (const m of modules) {
    if (!m.entryPoints.compute) continue;
    const module = checkWGSL(m.code);
    const constants = Object.assign({}, ...m.pipelines.filter((p) => p.compute).map((p) => p.compute.constants ?? {}));
    for (const entryPoint of m.entryPoints.compute) {
      const plan = planCompute({ module, entryPoint, constants });
      tiers[plan.tier]++;
    }
  }
  assert.ok(tiers.fragment >= 30 && tiers.scatter >= 250 && tiers.cpu >= 60, JSON.stringify(tiers));
});

test('CPU tier: f32 arithmetic rounds as an f32 GPU, integers follow WGSL', () => {
  const out = new Uint32Array(12);
  runComputeOnCPU({
    source: `@group(0) @binding(0) var<storage, read_write> o: array<u32, 12>;
      @compute @workgroup_size(1) fn main() {
        var a = 16777216.0; a = a + 1.0;
        o[0] = bitcast<u32>(a);
        o[1] = bitcast<u32>(0.1 * 3.0);
        var x = 7; var y = 0; var m = -2147483647 - 1; var neg = -1; var n7 = -7;
        o[2] = u32(x / y); o[3] = u32(x % y); o[4] = u32(m / neg); o[5] = u32(n7 / 2); o[6] = u32(n7 % 2);
        var big = 4294967295u; big = big + 2u; o[7] = big;
        o[8] = u32(i32(-1.9)); o[9] = u32(f32(3000000000.0)); o[10] = countOneBits(0xF0F0u) + reverseBits(1u);
        o[11] = u32(round(2.5)) + u32(round(3.5)) * 10u;
      }`,
    workgroups: [1],
    buffers: new Map([['0:0', out]]),
  });
  const f = new Float32Array(out.buffer);
  assert.equal(f[0], 16777216, '2^24 + 1 rounds back to 2^24 in f32');
  assert.equal(out[1], new Uint32Array(Float32Array.of(Math.fround(Math.fround(0.1) * 3)).buffer)[0]);
  assert.deepEqual([...out.slice(2, 8)], [7, 0, 0x80000000, -3 >>> 0, -1 >>> 0, 1]);
  assert.equal(out[8], -1 >>> 0);
  assert.equal(out[9], 3000000000);
  assert.equal(out[10], 8 + 0x80000000);
  assert.equal(out[11], 2 + 40, 'round() rounds half to even');
});

test('CPU tier: atomics, workgroup memory, barriers, pointers and composite copies', () => {
  const sums = new Uint32Array(4),
    count = new Uint32Array(1),
    copies = new Float32Array(8);
  runComputeOnCPU({
    source: `@group(0) @binding(0) var<storage, read_write> sums: array<u32, 4>;
      @group(0) @binding(1) var<storage, read_write> count: atomic<u32>;
      @group(0) @binding(2) var<storage, read_write> copies: array<vec4f, 2>;
      var<workgroup> part: array<u32, 16>;
      fn bump(p: ptr<function, vec4f>) { (*p).y += 10.0; }
      @compute @workgroup_size(16) fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
        atomicAdd(&count, li);
        part[li] = li + wg.x * 16u;
        workgroupBarrier();
        for (var s = 8u; s > 0u; s >>= 1u) { if (li < s) { part[li] += part[li + s]; } workgroupBarrier(); }
        if (li == 0u) { sums[wg.x] = workgroupUniformLoad(&part)[0]; }
        if (wg.x == 0u && li == 0u) {
          var v = vec4f(1.0, 2.0, 3.0, 4.0);
          let kept = v;
          bump(&v);
          v.x = 5.0;
          copies[0] = kept;
          copies[1] = v;
        }
      }`,
    workgroups: [4],
    buffers: new Map([
      ['0:0', sums],
      ['0:1', count],
      ['0:2', copies],
    ]),
  });
  assert.deepEqual([...sums], [120, 376, 632, 888]);
  assert.equal(count[0], 4 * 120);
  assert.deepEqual([...copies], [1, 2, 3, 4, 5, 12, 3, 4], 'a let keeps its value when the variable changes');
});

test('CPU tier: loops with continuing, switch, break and continue', () => {
  const out = new Uint32Array(4);
  runComputeOnCPU({
    source: `@group(0) @binding(0) var<storage, read_write> o: array<u32, 4>;
      @compute @workgroup_size(1) fn main() {
        var i = 0u; var n = 0u;
        loop { if (i == 2u) { i++; continue; } n += i; continuing { i++; break if i >= 6u; } }
        o[0] = n;
        var s = 0u;
        for (var k = 0u; k < 10u; k++) { switch (k % 3u) { case 0u: { continue; } case 1u: { s += 1u; } default: { s += 10u; break; } } if (k == 7u) { break; } }
        o[1] = s;
        var w = 0u; while (w < 5u) { w += 2u; } o[2] = w;
        o[3] = select(1u, 2u, n > 10u);
      }`,
    workgroups: [1],
    buffers: new Map([['0:0', out]]),
  });
  // i: 0 and 1 add, 2 skips (and steps twice), 4 and 5 add.
  assert.deepEqual([...out], [0 + 1 + 4 + 5, 1 + 10 + 1 + 10 + 1, 6, 1]);
});
