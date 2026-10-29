// Splats' route on the WebGL2 compatibility layer, loaded by import() only there.
// WebGL2 has no workgroup memory or atomics, so the layer would run the 8-pass radix sort's 32 dispatches (their
// histograms and scans share workgroup arrays) one invocation at a time on the CPU: about 44 ms a frame for 10,000
// splats. This kernel sorts the same keys in one invocation, which the layer runs on the CPU as plain loops: an LSD
// radix sort with 8-bit digits (4 passes over the keys instead of 8 with 4-bit digits). Both sorts are stable and
// order by the whole 32-bit key, so the order, and so the image, is the WebGPU route's. The projection stays on the GPU.

/** One invocation: `keys` sorted by `.x`, stable, through `spare`; the result ends in `keys`, as on WebGPU. */
export const cpuSort = `struct Sort {count:u32,groups:u32,blocks:u32,shift:u32}
@group(0) @binding(0) var<uniform> sort:Sort;
@group(0) @binding(1) var<storage,read_write> keys:array<vec2u>;
@group(0) @binding(2) var<storage,read_write> spare:array<vec2u>;
@compute @workgroup_size(1) fn main() {
  var at:array<u32,256>;
  for(var p=0u;p<4u;p++){
    let shift=p*8u;let even=p%2u==0u;
    for(var d=0u;d<256u;d++){at[d]=0u;}
    for(var i=0u;i<sort.count;i++){
      var key=0u;if(even){key=keys[i].x;}else{key=spare[i].x;}at[(key>>shift)&255u]+=1u;
    }
    var sum=0u;for(var d=0u;d<256u;d++){let n=at[d];at[d]=sum;sum+=n;}
    for(var i=0u;i<sort.count;i++){
      if(even){let k=keys[i];let d=(k.x>>shift)&255u;spare[at[d]]=k;at[d]+=1u;}
      else{let k=spare[i];let d=(k.x>>shift)&255u;keys[at[d]]=k;at[d]+=1u;}
    }
  }
}`;

/** The sort pipeline and its bind group: `sort` holds the splat count first, `keys` the projected keys and a spare. */
export function splatCompatSort(
  device: GPUDevice,
  sort: GPUBuffer,
  keys: readonly GPUBuffer[],
): { pipeline: GPUComputePipeline; group: GPUBindGroup } {
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: cpuSort }), entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [sort, keys[0], keys[1]].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  return { pipeline, group };
}
