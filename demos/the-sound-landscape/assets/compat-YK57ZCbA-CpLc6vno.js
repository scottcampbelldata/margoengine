var e=`struct Sort { count: u32, mask: u32, passes: u32, values: u32 }
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
}`;export{e as sortShader};