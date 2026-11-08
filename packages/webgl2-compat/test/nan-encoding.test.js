// A NaN leaves the CPU tier as one encoding. JavaScript lets an engine write any NaN bits (ECMA-262 25.1.3.17
// NumericToRawBytes) and V8 wrote 0x7fc00000 from one path and 0xffc00000 from the other for the same splat-lighting
// kernel of the corpus (interpret.test.js). WGSL lets a runtime NaN be any value (WGSL 15.7.2), so the tier writes the
// quiet NaN with sign 0 everywhere: buffer stores, bitcasts, f16 packing and storage textures, compiled or interpreted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { H } from '../src/compute/cpu.ts';

const CASES = `
@group(0) @binding(0) var<storage, read> i: array<f32>;
@group(0) @binding(1) var<storage, read_write> f: array<f32>;
@group(0) @binding(2) var<storage, read_write> u: array<u32>;
@group(0) @binding(3) var<storage, read_write> lit: array<vec4f>;
@compute @workgroup_size(1) fn cases() {
  let zero = i[0]; let one = i[1];
  let nan = zero / zero;
  f[0] = nan;
  f[1] = -nan;
  f[2] = sqrt(-one);
  f[3] = one / zero - one / zero;
  f[4] = zero * (one / zero);
  f[5] = normalize(vec3f(zero)).x;
  u[0] = bitcast<u32>(nan);
  u[1] = bitcast<u32>(-nan);
  u[2] = u32(bitcast<i32>(-nan));
  u[3] = pack2x16float(vec2f(nan, -nan));
}
// The corpus kernel's shape: a zero vector normalized, then a vec4 store, from 512 invocations.
@compute @workgroup_size(256) fn warm(@builtin(global_invocation_id) id: vec3u) {
  let n = normalize(vec3f(i[0]));
  let e = lit[id.x];
  lit[id.x] = vec4f(e.rgb * max(dot(n, vec3f(one())), 0.0), e.a);
}
fn one() -> f32 { return i[1]; }
`;

/** Runs both entry points in a fresh Node, with or without `new Function`, and gives the words each binding holds. */
function run(...flags) {
  const script = `
    import { loadInterpreter, runComputeOnCPU } from ${JSON.stringify(new URL('../dist/compute.js', import.meta.url).href)};
    let refused = false;
    try { new Function(''); } catch { refused = true; }
    if (refused) await loadInterpreter();
    const source = ${JSON.stringify(CASES)};
    const i = new Float32Array([0, 1, 0, 0]), f = new Float32Array(6), u = new Uint32Array(4),
      lit = new Float32Array(512 * 4).fill(0.5);
    const buffers = new Map([['0:0', i], ['0:1', f], ['0:2', u], ['0:3', lit]]);
    runComputeOnCPU({ source, entryPoint: 'cases', workgroups: [1], buffers });
    runComputeOnCPU({ source, entryPoint: 'warm', workgroups: [2], buffers });
    const words = (a) => [...new Uint32Array(a.buffer)];
    console.log(JSON.stringify({ refused, f: words(f), u: [...u], lit: [...new Set(words(lit))] }));`;
  const r = spawnSync(process.execPath, [...flags, '--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const QNAN = 0x7fc00000;
const want = {
  f: [QNAN, QNAN, QNAN, QNAN, QNAN, QNAN],
  u: [QNAN, QNAN, QNAN, 0x7e007e00],
  lit: [QNAN, 0x3f000000],
};

test('compiled kernels store, bitcast and pack every NaN as the quiet NaN with sign 0', () => {
  const out = run();
  assert.equal(out.refused, false);
  assert.deepEqual({ f: out.f, u: out.u, lit: out.lit }, want);
});

test('the interpreter (no new Function) stores, bitcasts and packs every NaN the same way', () => {
  const out = run('--disallow-code-generation-from-strings');
  assert.equal(out.refused, true, 'the flag must refuse new Function, or this compares nothing');
  assert.deepEqual({ f: out.f, u: out.u, lit: out.lit }, want);
});

test('a storage texture store writes a NaN as the quiet NaN with sign 0', () => {
  const data = new Float32Array(2 * 4);
  const level = { w: 2, h: 1, d: 1, data };
  const texture = { levels: 1, layers: 1, dimension: '2d', format: 'rgba32float', level: () => level };
  const nan = new Float64Array(new Uint32Array([0, 0xfff80000]).buffer)[0];
  H.ts(texture, [1, 0], 0, [nan, 1, -nan, 0]);
  assert.deepEqual([...new Uint32Array(data.buffer)], [0, 0, 0, 0, QNAN, 0x3f800000, QNAN, 0]);
});

test('bitcast and f16 helpers give the one NaN encoding whatever NaN bits come in', () => {
  const nan = new Float64Array(new Uint32Array([1, 0xfff80000]).buffer)[0];
  assert.equal(H.bfu(nan), QNAN);
  assert.equal(H.bfi(nan), QNAN);
  assert.equal(H.halfBits(nan), 0x7e00);
  assert.equal(H.halfBits(-Infinity), 0xfc00);
  const dv = new DataView(new ArrayBuffer(4));
  H.stf(dv, 0, nan);
  assert.equal(dv.getUint32(0, true), QNAN);
});
