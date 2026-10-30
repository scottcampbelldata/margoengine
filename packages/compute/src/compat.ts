// The compute package's sort route on the WebGL2 compatibility layer, loaded by import() only there. WebGL2 has no
// workgroup memory, so the layer runs the radix sort's local pass (a workgroup scan per 4-bit digit) one invocation at a
// time on its CPU tier, about 40 loop steps per key: past about 2.5 million keys a pass goes over the layer's CPU work
// budget (100 million steps) and is dropped, so a 4-million-key sort came back unsorted. This kernel sorts the same
// keys in one invocation, which the layer runs as plain loops: an LSD radix sort with 8-bit digits, about 9 steps per
// key for 32-bit keys. Both sorts are stable and order by the same low key bits, so the order is the WebGPU route's.

/** One invocation: `keys` (and `values` when `sort.values` is 1) sorted by `keys & sort.mask`, stable, in place. */
export const sortShader = /* wgsl */ `struct Sort { count: u32, mask: u32, passes: u32, values: u32 }
@group(0) @binding(0) var<uniform> sort: Sort;
@group(0) @binding(1) var<storage, read_write> keys: array<u32>;
@group(0) @binding(2) var<storage, read_write> values: array<u32>;
@group(0) @binding(3) var<storage, read_write> spareKeys: array<u32>;
@group(0) @binding(4) var<storage, read_write> spareValues: array<u32>;
@compute @workgroup_size(1) fn main() {
  var at: array<u32, 256>;
  for (var p = 0u; p < sort.passes; p++) {
    let shift = p * 8u;
    let even = p % 2u == 0u;
    for (var d = 0u; d < 256u; d++) { at[d] = 0u; }
    for (var i = 0u; i < sort.count; i++) {
      var key = 0u;
      if (even) { key = keys[i]; } else { key = spareKeys[i]; }
      at[((key & sort.mask) >> shift) & 255u] += 1u;
    }
    var sum = 0u;
    for (var d = 0u; d < 256u; d++) { let n = at[d]; at[d] = sum; sum += n; }
    for (var i = 0u; i < sort.count; i++) {
      if (even) {
        let key = keys[i];
        let d = ((key & sort.mask) >> shift) & 255u;
        spareKeys[at[d]] = key;
        if (sort.values == 1u) { spareValues[at[d]] = values[i]; }
        at[d] += 1u;
      } else {
        let key = spareKeys[i];
        let d = ((key & sort.mask) >> shift) & 255u;
        keys[at[d]] = key;
        if (sort.values == 1u) { values[at[d]] = spareValues[i]; }
        at[d] += 1u;
      }
    }
  }
  if (sort.passes % 2u == 1u) {
    for (var i = 0u; i < sort.count; i++) {
      keys[i] = spareKeys[i];
      if (sort.values == 1u) { values[i] = spareValues[i]; }
    }
  }
}`;
