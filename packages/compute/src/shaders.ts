// WGSL for the scan, sort, map and histogram primitives (reductions are in reduce.ts). Every kernel runs 256 threads
// per workgroup over a 2D grid of workgroups (so arrays past 65,535 workgroups still dispatch) and reads its linear
// workgroup index as wid.x + wid.y * nwg.x. Inputs are read through a fused expression's `value(i)` (expr.ts).
//
// Scan: each workgroup takes 1,024 consecutive elements, four per thread; a thread folds its four in order, the
// workgroup scans the 256 partials in shared memory (W. D. Hillis and G. L. Steele, "Data parallel algorithms", CACM
// 29(12), 1986), the per-block totals are scanned recursively and each block's prefix is added back (the
// reduce-then-scan scheme of G. E. Blelloch, "Prefix sums and their applications", CMU-CS-90-190, 1990). Segmented scan
// carries (flag, value) pairs with the operator (fa | fb, fb ? vb : va + vb), which is associative (J. T. Schwartz,
// "Ultracomputers", TOPLAS 2(4), 1980; Blelloch 1990, section 1.5). Every combine keeps the left operand first, so a
// custom operator only has to be associative.
//
// Sort: least-significant-digit radix sort on 32-bit keys, 4 bits per pass, after N. Satish, M. Harris and M. Garland,
// "Designing efficient sorting algorithms for manycore GPUs", IPDPS 2009: each 256-key block sorts itself on the digit
// with four stable one-bit splits, writes its digit counts (digit-major) and digit starts, the counts are scanned, and
// a scatter moves each key to its digit's global offset plus its rank inside the block.
import { typeError } from '../../shared/errors.js';
import type { DType } from './dtype.js';
import type { Fused } from './expr.js';

/** Threads per workgroup for every primitive. */
export const WG = 256;
/** Elements each reduce or scan workgroup covers (four per thread). */
export const BLOCK = 1024;

/** A binary operator: a built-in name or WGSL for `combine(a, b)` with its identity value. */
export type Operator = 'sum' | 'product' | 'min' | 'max' | { readonly combine: string; readonly identity: string };

const index = /* wgsl */ `fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;
const params = /* wgsl */ `struct Params { n: u32, inf: u32, a: u32, b: u32 }`;

/**
 * WGSL for `combine(a, b)` and the identity of `op` on `type`. Float infinities have no WGSL literal, so float min/max
 * identities read `params.inf` (0x7f800000, the f32 +Infinity bits; the f16 bits are derived from it).
 */
export function operator(op: Operator, type: DType): { combine: string; identity: string } {
  if (typeof op === 'object') {
    if (typeof op.combine !== 'string' || typeof op.identity !== 'string')
      throw typeError('A custom operator needs WGSL strings combine (of a and b) and identity', 'compute');
    return op;
  }
  const inf = type === 'f16' ? 'bitcast<vec2<f16>>((params.inf >> 16u) & 0x7c00u).x' : 'bitcast<f32>(params.inf)';
  switch (op) {
    case 'sum':
      return { combine: 'a + b', identity: `${type}(0)` };
    case 'product':
      return { combine: 'a * b', identity: `${type}(1)` };
    case 'min':
      return {
        combine: 'min(a, b)',
        identity: type === 'i32' ? 'i32(2147483647)' : type === 'u32' ? '0xffffffffu' : inf,
      };
    case 'max':
      return {
        combine: 'max(a, b)',
        identity: type === 'i32' ? '(-2147483647i - 1i)' : type === 'u32' ? '0u' : `-${inf}`,
      };
  }
}

/**
 * One scan level: each workgroup scans 1,024 values into `dst` (inclusive, or exclusive when `params.a` is 1) and
 * writes its total to `sums[group]`.
 */
export function scanShader(src: Fused, combine: string, identity: string): string {
  const t = src.dtype;
  return /* wgsl */ `${src.enables}${src.declarations}${params}
${index}
@group(0) @binding(${src.next}) var<storage, read_write> dst: array<${t}>;
@group(0) @binding(${src.next + 1}) var<storage, read_write> sums: array<${t}>;
@group(0) @binding(${src.next + 2}) var<uniform> params: Params;
var<workgroup> partial: array<${t}, 256>;
${src.fn}
fn combine(a: ${t}, b: ${t}) -> ${t} { return ${combine}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let base = g * 1024u + lid * 4u;
  var item: array<${t}, 4>;
  var acc: ${t} = ${identity};
  for (var k = 0u; k < 4u; k++) {
    var v: ${t} = ${identity};
    if (base + k < params.n) { v = value(base + k); }
    acc = combine(acc, v);
    item[k] = acc;
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 1u; offset < 256u; offset <<= 1u) {
    var v = partial[lid];
    if (lid >= offset) { v = combine(partial[lid - offset], v); }
    workgroupBarrier();
    partial[lid] = v;
    workgroupBarrier();
  }
  var before: ${t} = ${identity};
  if (lid > 0u) { before = partial[lid - 1u]; }
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
  if (lid == 255u) { sums[g] = partial[255]; }
}`;
}

/** Puts each block's scanned prefix `sums[group]` in front of the block's 1,024 elements of `data`. */
export function addShader(type: DType, combine: string): string {
  return /* wgsl */ `${type === 'f16' ? 'enable f16;\n' : ''}${params}
${index}
@group(0) @binding(0) var<storage, read_write> data: array<${type}>;
@group(0) @binding(1) var<storage, read> sums: array<${type}>;
@group(0) @binding(2) var<uniform> params: Params;
fn combine(a: ${type}, b: ${type}) -> ${type} { return ${combine}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let prefix = sums[g];
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { data[i] = combine(prefix, data[i]); }
  }
}`;
}

/**
 * One inclusive segmented scan level over (flag, value) pairs. Flags come from `flagsIn` or, when `periodic`, start a
 * segment every `params.b` elements (a scan along the last axis). Writes the block-local result to `dst`, whether a
 * segment started in the block at or before each element to `seen`, and each block's (any flag, last value) total.
 */
export function segmentedShader(src: Fused, combine: string, identity: string, periodic: boolean): string {
  const t = src.dtype,
    b = src.next;
  return /* wgsl */ `${src.enables}${src.declarations}${params}
${index}
@group(0) @binding(${b}) var<storage, read> flagsIn: array<u32>;
@group(0) @binding(${b + 1}) var<storage, read_write> dst: array<${t}>;
@group(0) @binding(${b + 2}) var<storage, read_write> seen: array<u32>;
@group(0) @binding(${b + 3}) var<storage, read_write> sumFlags: array<u32>;
@group(0) @binding(${b + 4}) var<storage, read_write> sumValues: array<${t}>;
@group(0) @binding(${b + 5}) var<uniform> params: Params;
var<workgroup> partialFlags: array<u32, 256>;
var<workgroup> partialValues: array<${t}, 256>;
${src.fn}
fn combine(a: ${t}, b: ${t}) -> ${t} { return ${combine}; }
fn flagAt(i: u32) -> u32 { ${periodic ? 'return select(0u, 1u, i % params.b == 0u);' : 'return select(0u, 1u, flagsIn[i] != 0u);'} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let base = g * 1024u + lid * 4u;
  var itemFlags: array<u32, 4>;
  var itemValues: array<${t}, 4>;
  var f = 0u;
  var v: ${t} = ${identity};
  for (var k = 0u; k < 4u; k++) {
    var fk = 0u;
    var vk: ${t} = ${identity};
    if (base + k < params.n) { fk = flagAt(base + k); vk = value(base + k); }
    if (fk == 1u) { v = vk; } else { v = combine(v, vk); }
    f = f | fk;
    itemFlags[k] = f;
    itemValues[k] = v;
  }
  partialFlags[lid] = f;
  partialValues[lid] = v;
  workgroupBarrier();
  for (var offset = 1u; offset < 256u; offset <<= 1u) {
    var pf = partialFlags[lid];
    var pv = partialValues[lid];
    if (lid >= offset && pf == 0u) {
      pv = combine(partialValues[lid - offset], pv);
      pf = partialFlags[lid - offset];
    } else if (lid >= offset) {
      pf = 1u;
    }
    workgroupBarrier();
    partialFlags[lid] = pf;
    partialValues[lid] = pv;
    workgroupBarrier();
  }
  var beforeFlag = 0u;
  var beforeValue: ${t} = ${identity};
  if (lid > 0u) { beforeFlag = partialFlags[lid - 1u]; beforeValue = partialValues[lid - 1u]; }
  for (var k = 0u; k < 4u; k++) {
    let i = base + k;
    if (i < params.n) {
      var out = itemValues[k];
      if (itemFlags[k] == 0u) { out = combine(beforeValue, out); }
      dst[i] = out;
      seen[i] = itemFlags[k] | beforeFlag;
    }
  }
  if (lid == 255u) { sumFlags[g] = partialFlags[255]; sumValues[g] = partialValues[255]; }
}`;
}

/** Adds the running value of the previous block (`scanned[group - 1]`) to elements before their block's first flag. */
export function segmentedAddShader(type: DType, combine: string): string {
  return /* wgsl */ `${type === 'f16' ? 'enable f16;\n' : ''}${params}
${index}
@group(0) @binding(0) var<storage, read_write> data: array<${type}>;
@group(0) @binding(1) var<storage, read> seen: array<u32>;
@group(0) @binding(2) var<storage, read> scanned: array<${type}>;
@group(0) @binding(3) var<uniform> params: Params;
fn combine(a: ${type}, b: ${type}) -> ${type} { return ${combine}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g == 0u || g * 1024u >= params.n) { return; }
  let prefix = scanned[g - 1u];
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n && seen[i] == 0u) { data[i] = combine(prefix, data[i]); }
  }
}`;
}

/** An input of a map: its name in the expression and its element type. */
interface MapInput {
  readonly name: string;
  readonly type: DType;
}

/**
 * Element-wise map: `out[i] = expression` with each input's element bound to its name, `i` the index and `n` the
 * size. An expression containing `return` is used as the function body instead.
 */
export function mapShader(inputs: readonly MapInput[], output: DType, expression: string): string {
  const f16 = output === 'f16' || inputs.some((input) => input.type === 'f16');
  const declarations = inputs
      .map((input, k) => `@group(0) @binding(${k + 1}) var<storage, read> in_${input.name}: array<${input.type}>;`)
      .join('\n'),
    parameters = inputs.map((input) => `${input.name}: ${input.type}`).join(', '),
    args = inputs.map((input) => `in_${input.name}[i]`).join(', '),
    body = /\breturn\b/.test(expression) ? expression : `return ${output}(${expression});`;
  return /* wgsl */ `${f16 ? 'enable f16;\n' : ''}${params}
${index}
@group(0) @binding(0) var<storage, read_write> out: array<${output}>;
${declarations}
@group(0) @binding(${inputs.length + 1}) var<uniform> params: Params;
fn f(i: u32, n: u32${parameters ? ', ' + parameters : ''}) -> ${output} { ${body} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  out[i] = f(i, params.n${args ? ', ' + args : ''});
}`;
}

/** WGSL turning a value of `type` into a u32 key whose unsigned order is the value order. */
function toKey(type: DType): string {
  switch (type) {
    case 'f32':
      return 'let bits = bitcast<u32>(v); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);';
    case 'f16':
      return 'let bits = bitcast<u32>(f32(v)); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);';
    case 'i32':
      return 'return bitcast<u32>(v) ^ 0x80000000u;';
    case 'u32':
      return 'return v;';
  }
}

/**
 * Sort keys from the input: floats flip all bits of negatives and the sign bit of positives, signed integers flip the
 * sign bit, so unsigned order is value order; `params.a` 1 inverts them for a descending sort. Also writes 0, 1, 2,
 * ... into `order` when `params.b` is 1 (the payload of an argsort).
 */
export function keyShader(src: Fused): string {
  return /* wgsl */ `${src.enables}${src.declarations}${params}
${index}
@group(0) @binding(${src.next}) var<storage, read_write> keys: array<u32>;
@group(0) @binding(${src.next + 1}) var<storage, read_write> order: array<u32>;
@group(0) @binding(${src.next + 2}) var<uniform> params: Params;
${src.fn}
fn toKey(v: ${src.dtype}) -> u32 { ${toKey(src.dtype)} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = toKey(value(i));
  if (params.a == 1u) { k = ~k; }
  keys[i] = k;
  if (params.b == 1u) { order[i] = i; }
}`;
}

/** Turns sorted u32 keys back into values of `type` (undoing `keyShader`). */
export function fromKeyShader(type: DType): string {
  const from =
    type === 'f32'
      ? 'return bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u));'
      : type === 'f16'
        ? 'return f16(bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u)));'
        : type === 'i32'
          ? 'return bitcast<i32>(k ^ 0x80000000u);'
          : 'return k;';
  return /* wgsl */ `${type === 'f16' ? 'enable f16;\n' : ''}${params}
${index}
@group(0) @binding(0) var<storage, read> keys: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<${type}>;
@group(0) @binding(2) var<uniform> params: Params;
fn fromKey(k: u32) -> ${type} { ${from} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = keys[i];
  if (params.a == 1u) { k = ~k; }
  dst[i] = fromKey(k);
}`;
}

// Radix pass parameters: n keys, the digit's bit shift, the block count, and 1 when values travel with the keys.
const radixParams = /* wgsl */ `struct Radix { n: u32, shift: u32, blocks: u32, values: u32 }`;

/**
 * Radix pass, step 1: each 256-key block sorts itself on the 4-bit digit at `shift` (four stable one-bit splits),
 * writes the sorted block, its digit counts (`counts[digit * blocks + block]`) and digit starts
 * (`starts[block * 16 + digit]`). Slots past `n` hold 0xffffffff keys, which sort after every real key of the block.
 */
export const radixLocalShader = /* wgsl */ `${radixParams}
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
var<workgroup> scan: array<u32, 256>;
var<workgroup> histogram: array<atomic<u32>, 16>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks) { return; }
  let i = g * 256u + lid;
  var key = 0xffffffffu;
  var value = 0u;
  if (i < radix.n) {
    key = keysIn[i];
    if (radix.values == 1u) { value = valuesIn[i]; }
  }
  if (lid < 16u) { atomicStore(&histogram[lid], 0u); }
  for (var b = 0u; b < 4u; b++) {
    let bit = (key >> (radix.shift + b)) & 1u;
    scan[lid] = 1u - bit;
    workgroupBarrier();
    for (var offset = 1u; offset < 256u; offset <<= 1u) {
      var v = scan[lid];
      if (lid >= offset) { v += scan[lid - offset]; }
      workgroupBarrier();
      scan[lid] = v;
      workgroupBarrier();
    }
    let zeros = scan[255];
    let zerosBefore = scan[lid] - (1u - bit);
    var dest = zerosBefore;
    if (bit == 1u) { dest = zeros + lid - zerosBefore; }
    workgroupBarrier();
    sharedKeys[dest] = key;
    sharedValues[dest] = value;
    workgroupBarrier();
    key = sharedKeys[lid];
    value = sharedValues[lid];
    workgroupBarrier();
  }
  let valid = min(256u, radix.n - g * 256u);
  let digit = (key >> radix.shift) & 15u;
  if (lid < valid) { atomicAdd(&histogram[digit], 1u); }
  keysLocal[i] = key;
  valuesLocal[i] = value;
  workgroupBarrier();
  if (lid < 16u) {
    counts[lid * radix.blocks + g] = atomicLoad(&histogram[lid]);
    var start = 0u;
    for (var d = 0u; d < lid; d++) { start += atomicLoad(&histogram[d]); }
    starts[g * 16u + lid] = start;
  }
}`;

/** Radix pass, step 2 (after the counts are scanned into offsets): moves each key of a sorted block to its place. */
export const radixScatterShader = /* wgsl */ `${radixParams}
${index}
@group(0) @binding(0) var<storage, read> keysLocal: array<u32>;
@group(0) @binding(1) var<storage, read> valuesLocal: array<u32>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read> starts: array<u32>;
@group(0) @binding(4) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> valuesOut: array<u32>;
@group(0) @binding(6) var<uniform> radix: Radix;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks || lid >= min(256u, radix.n - g * 256u)) { return; }
  let key = keysLocal[g * 256u + lid];
  let digit = (key >> radix.shift) & 15u;
  let dest = offsets[digit * radix.blocks + g] + lid - starts[g * 16u + digit];
  keysOut[dest] = key;
  if (radix.values == 1u) { valuesOut[dest] = valuesLocal[g * 256u + lid]; }
}`;

/** Most bins counted in workgroup memory (16 KB); more bins count straight into the global array. */
export const LOCAL_BINS = 4096;

/**
 * Histogram: counts values in `bins` equal bins over [lo, hi] (read from `range`, which the GPU may have just
 * computed) into `counts`, the last bin closed, values outside the range and NaN skipped. `local` counts in workgroup
 * memory first.
 */
export function histogramShader(src: Fused, local: boolean): string {
  const target = local ? 'localCounts' : 'counts';
  return /* wgsl */ `${src.enables}${src.declarations}struct Bins { n: u32, bins: u32, pad0: u32, pad1: u32 }
${index}
@group(0) @binding(${src.next}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${src.next + 1}) var<storage, read> range: array<f32>;
@group(0) @binding(${src.next + 2}) var<uniform> params: Bins;
${local ? `var<workgroup> localCounts: array<atomic<u32>, ${LOCAL_BINS}>;` : ''}
${src.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let lo = range[0];
  let hi = range[1];
  let scale = f32(params.bins) / (hi - lo);
  ${local ? 'for (var b = lid; b < params.bins; b += 256u) { atomicStore(&localCounts[b], 0u); }\n  workgroupBarrier();' : ''}
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + k * 256u + lid;
    if (i < params.n) {
      let x = f32(value(i));
      if (x >= lo && x <= hi) {
        let bin = min(u32((x - lo) * scale), params.bins - 1u);
        atomicAdd(&${target}[bin], 1u);
      }
    }
  }
  ${
    local
      ? `workgroupBarrier();
  for (var b = lid; b < params.bins; b += 256u) {
    let c = atomicLoad(&localCounts[b]);
    if (c > 0u) { atomicAdd(&counts[b], c); }
  }`
      : ''
  }
}`;
}
