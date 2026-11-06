// @margoengine/compute/subgroups: reductions, scans and the radix sort on WebGPU subgroups. useSubgroups(gpu) swaps the
// context's kernels for versions that fold and scan inside a subgroup with no workgroup memory or barrier, and that
// rank a whole radix digit with four ballots instead of four one-bit splits. Every call on the context keeps its API
// and bindings; only the kernels change.
//
// WGSL promises neither a subgroup size nor which invocations share a subgroup, so nothing here reads either from
// local_invocation_index. Each subgroup takes a seat: one atomic hands it the next run of logical lanes and the next
// slot, and its invocations are ordered inside the run by subgroup_invocation_id. Lanes in order are the positions a
// thread works on, so a scan, a stable sort and a custom operator keep their left-to-right order on any subgroup size,
// and subgroups of equal size give the same result on every run although seats are taken in any order. A workgroup of
// 256 is a whole number of subgroups at every size WebGPU allows (powers of two from 4 to 128), so ids are dense.
//
// Radix ranking by ballots follows the multisplit of S. Ashkiani, A. Davidson, U. Meyer and J. D. Owens, "GPU
// Multisplit", PPoPP 2016, and the per-digit match masks of A. Adinets and D. Merrill, "Onesweep: a faster least
// significant digit radix sort for GPUs", arXiv 2206.01784, 2022.
import type { ComputeContext } from './context.js';
import type { Fused } from './expr.js';
import type { KernelRoute } from './shaders.js';

const index = /* wgsl */ `fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;
const params = /* wgsl */ `struct Params { n: u32, inf: u32, len: u32, inner: u32 }`;
const entry = /* wgsl */ `@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(subgroup_invocation_id) rank: u32)`;

// Takes a seat: `lane` is this invocation's logical position in the workgroup, `slot` its subgroup's, `size` the number
// of invocations in the subgroup. Runs in uniform control flow; the low 16 bits of `seats` count lanes, the high slots.
const seat = /* wgsl */ `let size = subgroupAdd(1u);
  var taken = 0u;
  if (subgroupElect()) { taken = atomicAdd(&seats, size | 0x10000u); }
  taken = subgroupBroadcastFirst(taken);
  let lane = (taken & 0xffffu) + rank;
  let slot = taken >> 16u;`;

// The hardware's own fold for the built-in operators; anything else folds by shuffles, left operand first.
const BUILTIN: Readonly<Record<string, string>> = {
  'a + b': 'subgroupAdd',
  'a * b': 'subgroupMul',
  'min(a, b)': 'subgroupMin',
  'max(a, b)': 'subgroupMax',
};

const fold = (combine: string) => {
  const builtin = BUILTIN[combine];
  if (builtin) return `let folded = ${builtin}(acc);`;
  return /* wgsl */ `var folded = acc;
  for (var offset = 1u; offset < 128u; offset <<= 1u) {
    let other = subgroupShuffleDown(folded, offset);
    if (rank + offset < size) { folded = combine(folded, other); }
  }`;
};

// Stores each subgroup's fold, then the first lane folds the slots in order into `target`.
const finish = (target: string) => /* wgsl */ `if (rank == 0u) { partial[slot] = folded; }
  workgroupBarrier();
  if (lane == 0u) {
    var total = partial[0];
    let slots = atomicLoad(&seats) >> 16u;
    for (var s = 1u; s < slots; s++) { total = combine(total, partial[s]); }
    ${target} = total;
  }`;

const head = (src: Fused, combine: string) => /* wgsl */ `enable subgroups;
${src.enables}${src.declarations}${params}
${index}
@group(0) @binding(${src.next}) var<storage, read_write> dst: array<${src.dtype}>;
@group(0) @binding(${src.next + 1}) var<uniform> params: Params;
var<workgroup> partial: array<${src.dtype}, 256>;
var<workgroup> seats: atomic<u32>;
${src.fn}
fn combine(a: ${src.dtype}, b: ${src.dtype}) -> ${src.dtype} { return ${combine}; }`;

/** WGSL for one tree level over 1,024-element blocks, with the bindings of the default level kernel. */
export function subgroupLevelShader(src: Fused, combine: string, identity: string): string {
  // A built-in operator commutes, so neighbouring threads can read neighbouring elements; a custom one keeps runs.
  const at = BUILTIN[combine] ? 'k * 256u + lane' : 'lane * 4u + k';
  return /* wgsl */ `${head(src, combine)}
${entry} {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  ${seat}
  var acc: ${src.dtype} = ${identity};
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + ${at};
    if (i < params.n) { acc = combine(acc, value(i)); }
  }
  ${fold(combine)}
  ${finish('dst[g]')}
}`;
}

/** WGSL folding one axis with a workgroup per output, with the bindings of the default kernel. */
export function subgroupAxisShader(src: Fused, combine: string, identity: string): string {
  return /* wgsl */ `${head(src, combine)}
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }
${entry} {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  ${seat}
  let run = (params.len + 255u) / 256u;
  var acc: ${src.dtype} = ${identity};
  for (var k = lane * run; k < min(params.len, lane * run + run); k++) { acc = combine(acc, value(at(o, k))); }
  ${fold(combine)}
  ${finish('dst[o]')}
}`;
}

/** WGSL for one scan level over 1,024 values, with the bindings of the default scan kernel. */
export function subgroupScanShader(src: Fused, combine: string, identity: string): string {
  const t = src.dtype;
  return /* wgsl */ `enable subgroups;
${src.enables}${src.declarations}struct Params { n: u32, inf: u32, a: u32, b: u32 }
${index}
@group(0) @binding(${src.next}) var<storage, read_write> dst: array<${t}>;
@group(0) @binding(${src.next + 1}) var<storage, read_write> sums: array<${t}>;
@group(0) @binding(${src.next + 2}) var<uniform> params: Params;
var<workgroup> partial: array<${t}, 256>;
var<workgroup> seats: atomic<u32>;
${src.fn}
fn combine(a: ${t}, b: ${t}) -> ${t} { return ${combine}; }
${entry} {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  ${seat}
  let base = g * 1024u + lane * 4u;
  var item: array<${t}, 4>;
  var acc: ${t} = ${identity};
  for (var k = 0u; k < 4u; k++) {
    var v: ${t} = ${identity};
    if (base + k < params.n) { v = value(base + k); }
    acc = combine(acc, v);
    item[k] = acc;
  }
  var running = acc;
  for (var offset = 1u; offset < 128u; offset <<= 1u) {
    let other = subgroupShuffleUp(running, offset);
    if (rank >= offset) { running = combine(other, running); }
  }
  if (rank + 1u == size) { partial[slot] = running; }
  workgroupBarrier();
  var before: ${t} = ${identity};
  for (var s = 0u; s < slot; s++) { before = combine(before, partial[s]); }
  let left = subgroupShuffleUp(running, 1u);
  if (rank > 0u) { before = combine(before, left); }
  for (var k = 0u; k < 4u; k++) {
    if (base + k < params.n) {
      if (params.a == 1u) {
        var previous = before;
        if (k > 0u) { previous = combine(before, item[k - 1u]); }
        dst[base + k] = previous;
      } else {
        dst[base + k] = combine(before, item[k]);
      }
    }
  }
  if (lane == 255u) { sums[g] = combine(before, acc); }
}`;
}

/**
 * The radix sort's local pass with the bindings and outputs of the default one: each 256-key block sorted on the 4-bit
 * digit at `shift`, its digit counts and starts. Four ballots give every key the mask of the keys in its subgroup with
 * the same digit, so its rank is a population count, and one exchange through workgroup memory replaces four one-bit
 * splits. Slots past `n` hold 0xffffffff keys: digit 15, and last in it, since they have the highest lanes.
 */
export const subgroupRadixLocalShader = /* wgsl */ `enable subgroups;
struct Radix { n: u32, shift: u32, blocks: u32, values: u32 }
${index}
@group(0) @binding(0) var<storage, read> keysIn: array<u32>;
@group(0) @binding(1) var<storage, read> valuesIn: array<u32>;
@group(0) @binding(2) var<storage, read_write> keysLocal: array<u32>;
@group(0) @binding(3) var<storage, read_write> valuesLocal: array<u32>;
@group(0) @binding(4) var<storage, read_write> counts: array<u32>;
@group(0) @binding(5) var<storage, read_write> starts: array<u32>;
@group(0) @binding(6) var<uniform> radix: Radix;
var<workgroup> sharedKeys: array<u32, 256>;
var<workgroup> sharedValues: array<u32, 256>;
var<workgroup> seats: atomic<u32>;
var<workgroup> tally: array<u32, 1024>;
var<workgroup> totals: array<u32, 16>;
var<workgroup> digitStarts: array<u32, 16>;
fn lanesBelow(rank: u32) -> vec4u {
  var mask = vec4u(0u);
  for (var w = 0u; w < 4u; w++) {
    let bits = rank - min(rank, w * 32u);
    mask[w] = select((1u << bits) - 1u, 0xffffffffu, bits >= 32u);
  }
  return mask;
}
${entry.replace('@builtin(subgroup_invocation_id) rank: u32', '@builtin(subgroup_invocation_id) rank: u32, @builtin(local_invocation_index) lid: u32')} {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks) { return; }
  ${seat}
  let i = g * 256u + lane;
  var key = 0xffffffffu;
  var value = 0u;
  if (i < radix.n) {
    key = keysIn[i];
    if (radix.values == 1u) { value = valuesIn[i]; }
  }
  let digit = (key >> radix.shift) & 15u;
  var same = subgroupBallot(true);
  for (var b = 0u; b < 4u; b++) {
    let high = ((digit >> b) & 1u) == 1u;
    let ballot = subgroupBallot(high);
    same &= select(~ballot, ballot, high);
  }
  let lower = countOneBits(same & lanesBelow(rank));
  let rankInDigit = lower.x + lower.y + lower.z + lower.w;
  let peers = countOneBits(same);
  if (rankInDigit == 0u) { tally[digit * 64u + slot] = peers.x + peers.y + peers.z + peers.w; }
  workgroupBarrier();
  let slots = atomicLoad(&seats) >> 16u;
  if (lid < 16u) {
    var sum = 0u;
    for (var s = 0u; s < slots; s++) {
      let c = tally[lid * 64u + s];
      tally[lid * 64u + s] = sum;
      sum += c;
    }
    totals[lid] = sum;
  }
  workgroupBarrier();
  if (lid < 16u) {
    var start = 0u;
    for (var d = 0u; d < lid; d++) { start += totals[d]; }
    digitStarts[lid] = start;
  }
  workgroupBarrier();
  let dest = digitStarts[digit] + tally[digit * 64u + slot] + rankInDigit;
  sharedKeys[dest] = key;
  if (radix.values == 1u) { sharedValues[dest] = value; }
  workgroupBarrier();
  keysLocal[g * 256u + lid] = sharedKeys[lid];
  if (radix.values == 1u) { valuesLocal[g * 256u + lid] = sharedValues[lid]; }
  if (lid < 16u) {
    let padding = 256u - min(256u, radix.n - g * 256u);
    counts[lid * radix.blocks + g] = totals[lid] - select(0u, padding, lid == 15u);
    starts[g * 16u + lid] = digitStarts[lid];
  }
}`;

// f16 keeps the default kernels: subgroup operations on f16 need more of the driver than the f32 ones do.
const wide = <A extends unknown[]>(shader: (src: Fused, ...rest: A) => string) => {
  return (src: Fused, ...rest: A): string | undefined => (src.dtype === 'f16' ? undefined : shader(src, ...rest));
};

const route: KernelRoute = {
  level: wide(subgroupLevelShader),
  axis: wide(subgroupAxisShader),
  scan: wide(subgroupScanShader),
  radixLocal: subgroupRadixLocalShader,
};

/**
 * Runs the context's reductions, flat scans and radix sorts on subgroups when its device has them. `gpu.sum`,
 * `gpu.cumsum`, `gpu.sort` and all that is built on them keep their API. Returns true when the subgroup kernels are in
 * use, false when the device lacks the `subgroups` feature (the CPU backend, the WebGL2 layer,
 * or a shared device made without it), in which case nothing changes. Integer results, orders and sorts stay exactly
 * the same; float sums round in another order, and that order depends on the GPU's subgroup size.
 * @example
 * using gpu = await createCompute();
 * useSubgroups(gpu); // true on most current GPUs
 * const total = await gpu.array(new Float32Array(1 << 20).fill(1)).sum().item();
 */
export function useSubgroups(gpu: ComputeContext): boolean {
  gpu.check();
  if (!gpu.subgroups) return false;
  gpu.kernelRoute = route;
  return true;
}
