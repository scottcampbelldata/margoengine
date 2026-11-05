// An exact exclusive prefix count of flag words without atomics or workgroup memory, for the packages' routes on the
// WebGL2 compatibility layer (the WebGL2 roadmap, "Package routes"), where every kernel here runs as a point
// draw: each invocation stores one word at its own index. Sums of 16 go up the levels until a level has at most 16
// words; then each index takes its parent's count plus at most 15 neighbours on the way down. Integers, so the result
// is exact and independent of draw order. Only the routes import this file, so WebGPU pages never download it.
//
// Several lists share one count as lanes: lane l, index i at word l * n + i. A lane's exclusive prefix is then
// prefix[l * n + i] - prefix[l * n], and its total is the next lane's start minus its own.

// GPUBufferUsage.STORAGE, UNIFORM and COPY_DST, as numbers: createCompatGPU() runs without the layer's globals.
const STORAGE = 0x80,
  UNIFORM = 0x40,
  COPY_DST = 0x08;

const declarations = /* wgsl */ `@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> words:array<u32>;
`;
/** One word per 16 of the level below: their sum. `n.x` is the level below's length. */
export const prefixUpShader =
  declarations +
  /* wgsl */ `@group(0) @binding(2) var<storage,read_write> sums:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  let first=id.x*16u;if(first>=n.x){return;}
  var sum=0u;for(var j=first;j<min(first+16u,n.x);j++){sum+=words[j];}
  sums[id.x]=sum;
}`;
/** The top level, `n.x` <= 16 words: each index 0..n.x counts the words before it. */
export const prefixTopShader =
  declarations +
  /* wgsl */ `@group(0) @binding(2) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>n.x){return;}
  var count=0u;for(var j=0u;j<id.x;j++){count+=words[j];}
  counts[id.x]=count;
}`;
/** A lower level: each index 0..n.x is its parent's count plus the words before it under that parent. */
export const prefixDownShader =
  declarations +
  /* wgsl */ `@group(0) @binding(2) var<storage,read_write> counts:array<u32>;
@group(0) @binding(3) var<storage,read> parents:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>n.x){return;}
  var count=parents[id.x>>4u];for(var j=id.x&~15u;j<id.x;j++){count+=words[j];}
  counts[id.x]=count;
}`;

/** The lengths of the levels for `words` flag words, from the flags up to the first of at most 16. */
export function prefixLevels(words) {
  const levels = [words];
  while (levels.at(-1) > 16) levels.push(Math.ceil(levels.at(-1) / 16));
  return levels;
}

/**
 * The GPU state of one prefix count over `words` flag words. A kernel of the route writes `flags`, one 0 or 1 per word;
 * after {@link PrefixCount#encode}, `prefix` holds at index i the flags before it (`words + 1` words, the last one the
 * total) and word {@link PrefixCount#totalWord} of `total` the sum of all flags. With `totalOnly` only the total is made.
 */
export class PrefixCount {
  constructor(device, words, owned, { totalOnly = false } = {}) {
    if (!Number.isInteger(words) || words < 1)
      throw new RangeError('A prefix count needs at least one flag word; pass a positive whole number');
    const make = (bytes, usage) => {
      const made = device.createBuffer({ size: bytes, usage });
      owned.push(made);
      return made;
    };
    const lengths = prefixLevels(words),
      pipeline = (code) =>
        device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
        }),
      up = pipeline(prefixUpShader),
      top = pipeline(prefixTopShader),
      down = totalOnly || lengths.length === 1 ? undefined : pipeline(prefixDownShader);
    /** @type {[GPUComputePipeline, GPUBindGroup, number][]} */
    this.steps = [];
    const step = (p, length, count, entries) => {
      const uniform = make(16, UNIFORM | COPY_DST);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([length, 0, 0, 0]));
      this.steps.push([
        p,
        device.createBindGroup({
          layout: p.getBindGroupLayout(0),
          entries: [uniform, ...entries].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
        Math.ceil(count / 256),
      ]);
    };
    this.flags = make(Math.max(16, words * 4), STORAGE);
    const sums = [this.flags];
    for (let k = 1; k < lengths.length; k++) {
      const next = make(lengths[k] * 4, STORAGE);
      step(up, lengths[k - 1], lengths[k], [sums[k - 1], next]);
      sums.push(next);
    }
    const last = lengths.length - 1;
    let counts = make((lengths[last] + 1) * 4, STORAGE);
    step(top, lengths[last], lengths[last] + 1, [sums[last], counts]);
    this.total = counts;
    this.totalWord = lengths[last];
    if (down)
      for (let k = last - 1; k >= 0; k--) {
        const next = make((lengths[k] + 1) * 4, STORAGE);
        step(down, lengths[k], lengths[k] + 1, [sums[k], next, counts]);
        counts = next;
      }
    this.prefix = counts;
  }
  /** Records the count; the flags must have been written earlier in the same or an earlier pass. */
  encode(pass) {
    for (const [pipeline, group, count] of this.steps) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(count);
    }
  }
}
