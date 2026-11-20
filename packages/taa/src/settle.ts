// Settling a still view (KB-TAA-STILL1). With the camera and the scene still, TAA and TAAUpscale used to keep cycling
// through their jitter phases: each frame blended one phase into an exponential history clamped to that phase's
// neighbourhood, so small highlights and thin wires changed by up to 189 levels from frame to frame forever.
//
// A still pixel should show the mean of every phase, which is the supersampled value amortised over frames as in
// L. Yang, D. Nehab, P. V. Sander, P. Sitthi-amorn, J. Lawrence and H. Hoppe, "Amortized Supersampling" (ACM TOG 28(5),
// 2009), and then hold it. The hard part is telling a pixel that changes only with the jitter from one whose scene
// changed (a moving object, a moving shadow, an animated light): a colour range learned from the jitter cannot do it,
// since what the jitter shows at a highlight or a wire is as far from the mean as a passing object is. The jitter
// itself gives the answer: the Halton sequence repeats every `phases` frames, so with the camera still a pixel's sample
// in phase k must equal its sample in phase k one cycle ago, bit for bit, unless the scene changed. That is the
// temporal gradient of C. Schied, C. Peters and C. Dachsbacher, "Gradient Estimation for Real-Time Adaptive Temporal
// Filtering" (A-SVGF, HPG 2018), who re-shade a sample with last frame's random sequence to separate change from noise;
// here the repeating jitter supplies the same sample for free. Each render pixel keeps an 8-bit hash of its sample in
// every phase (pcg4d, M. Jarzynski and M. Olano, "Hash Functions for GPU Rendering", JCGT 9(3), 2020) and a count of the
// frames in a row whose sample matched. A pixel whose 3x3 render footprint has matched for a whole cycle averages the
// next cycle's samples with equal weight, and from then shows that mean and keeps it; any mismatch in the footprint, a
// camera move or a reset hands it back to the clamped history at once, so a moving surface is never held. Rendering is
// deterministic for a fixed input, so a still scene matches exactly; a scene with per-frame noise never matches and keeps
// the clamped history it always had. A missed change needs the hash of every footprint pixel to collide (1 in 256 each).
// Memory: (ceil(phases / 3) + 1) 4-byte words per render pixel and two rgba16float textures at output size.
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number; COPY_DST: number };

/** Hashes per slot word: three 8-bit sample hashes, then the 8-bit count of consecutive matching frames. */
const perWord = 3;

/** Detect pass, at render size: compare this phase's sample with the one a cycle ago and count the frames in a row. */
export const settleDetect = `@group(0) @binding(0) var<uniform> settle:vec4u;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var slots:texture_2d_array<u32>;
@group(0) @binding(3) var word:texture_storage_2d<r32uint,write>;
fn sampleHash(c:vec3f)->u32 {var v=bitcast<vec4u>(vec4f(c,1))*1664525u+1013904223u;
 v.x+=v.y*v.w;v.y+=v.z*v.x;v.z+=v.x*v.y;v.w+=v.y*v.z;v=v^(v>>vec4u(16u));
 v.x+=v.y*v.w;v.y+=v.z*v.x;v.z+=v.x*v.y;v.w+=v.y*v.z;return (v.x^v.y^v.z^v.w)>>24u;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 let size=textureDimensions(scene);if(any(id.xy>=size)){return;}let p=vec2i(id.xy);
 let shift=(settle.x%${perWord}u)*8u;let old=textureLoad(slots,p,settle.x/${perWord}u,0).r;
 let before=textureLoad(slots,p,settle.w/${perWord}u,0).r>>24u;let h=sampleHash(textureLoad(scene,p,0).rgb);
 let n=select(0u,min(before+1u,255u),settle.z>0u&&((old>>shift)&255u)==h);
 textureStore(word,p,vec4u((old&~(255u<<shift)&0xffffffu)|(h<<shift)|(n<<24u),0u,0u,0u));
}`;

/** Group 1 of a resolve that settles: the frames each render pixel has matched, and the running mean. */
const settleCode = `@group(1) @binding(0) var<uniform> settle:vec4u;
@group(1) @binding(1) var settleWords:texture_2d<u32>;
@group(1) @binding(2) var settleHistory:texture_2d<f32>;
@group(1) @binding(3) var settleOutput:texture_storage_2d<rgba16float,write>;
fn settled(p:vec2i,m:u32,x:vec3f,result:vec3f)->vec3f {
 let old=textureLoad(settleHistory,p,0).rgb;let s=select(select(x,old+(x-old)/f32(m+1u),m>0u),old,m>=settle.y);
 textureStore(settleOutput,p,vec4f(s,1));return select(result,s,m>=settle.y);
}
`;

/**
 * Adds settling to a resolve shader: before its output store, the fewest matched frames over the 3x3 render pixels
 * round `centre` (clamped to `top`) picks the running mean of the sample `current` or the shader's `result`.
 */
export function settleResolve(code: string, centre: string, top: string): string {
  const store = 'textureStore(output,p,';
  if (code.split(store).length !== 2 || !code.includes('@compute'))
    throw new MargoError('state', 'TAA settle patch target missing; update settleResolve to the resolve shader');
  // A reactive pixel (particles, weather, splats: TAAOptions.reactive, now or last frame) distrusts its history in the
  // blend, so it never settles either: it counts as no frames matched, shows the blend and restarts its mean.
  const reactive = code.includes('var reactAll=') ? 'settleFrames=select(settleFrames,0u,reactAll>0.0);' : '';
  return code
    .replace('@compute', settleCode + '@compute')
    .replace(
      store,
      'var settleFrames=255u;for(var sy=-1;sy<=1;sy++){for(var sx=-1;sx<=1;sx++){' +
        `settleFrames=min(settleFrames,textureLoad(settleWords,clamp(${centre}+vec2i(sx,sy),vec2i(0),${top}),0).r>>24u);}}` +
        reactive +
        'result=settled(p,settleFrames,current,result);' +
        store,
    );
}

/** The textures, pipeline and groups of one view's settling. */
export class Settle {
  private readonly slots: GPUTexture;
  private readonly word: GPUTexture;
  private readonly means: GPUTexture[];
  private readonly uniform: GPUBuffer;
  private readonly values = new Uint32Array(4);
  private readonly pipeline: GPUComputePipeline;
  private detect?: GPUBindGroup;
  private source?: GPUTextureView;
  private groups: GPUBindGroup[] = [];
  private readonly device: GPUDevice;
  private readonly size: readonly [number, number];
  /** Jitter phases in one cycle. */
  readonly phases: number;

  constructor(device: GPUDevice, size: readonly [number, number], output: readonly [number, number], phases: number) {
    this.device = device;
    this.size = size;
    this.phases = phases;
    const layers = Math.ceil(phases / perWord),
      made: (GPUTexture | GPUBuffer)[] = [],
      texture = (descriptor: GPUTextureDescriptor) => {
        const t = device.createTexture(descriptor);
        made.push(t);
        return t;
      };
    try {
      this.slots = texture({
        label: 'TAA settle slots',
        size: [size[0], size[1], layers],
        format: 'r32uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.word = texture({
        label: 'TAA settle word',
        size: [size[0], size[1]],
        format: 'r32uint',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.means = [0, 1].map((i) =>
        texture({
          label: `TAA settle mean ${i}`,
          size: [output[0], output[1]],
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
      this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      made.push(this.uniform);
      this.pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: settleDetect }), entryPoint: 'main' },
      });
    } catch (error) {
      // A failed allocation leaves nothing behind; the caller retries the whole frame.
      for (const r of made) r.destroy();
      throw error;
    }
  }

  /** This frame's phase (0 to phases - 1) and whether the camera is exactly as last frame with valid history. */
  write(phase: number, still: boolean): void {
    const v = this.values;
    v[0] = phase;
    v[1] = this.phases;
    v[2] = +still;
    v[3] = (phase + this.phases - 1) % this.phases;
    this.device.queue.writeBuffer(this.uniform, 0, v as Uint32Array<ArrayBuffer>);
  }

  /** Group 1 of `resolve` for each history direction: read mean i, write mean 1 - i. */
  bind(resolve: GPUComputePipeline): void {
    const layout = resolve.getBindGroupLayout(1),
      words = this.word.createView();
    this.groups = [0, 1].map((i) =>
      this.device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: words },
          { binding: 2, resource: this.means[i].createView() },
          { binding: 3, resource: this.means[1 - i].createView() },
        ],
      }),
    );
  }

  group(front: number): GPUBindGroup {
    return this.groups[front];
  }

  /** Records the detect pass on `scene` (render size) and keeps this phase's word for the next cycle. */
  run(encoder: GPUCommandEncoder, scene: GPUTextureView): void {
    if (scene !== this.source || !this.detect) {
      this.source = scene;
      this.detect = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: scene },
          { binding: 2, resource: this.slots.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: this.word.createView() },
        ],
      });
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.detect);
    pass.dispatchWorkgroups(Math.ceil(this.size[0] / 8), Math.ceil(this.size[1] / 8));
    pass.end();
    encoder.copyTextureToTexture(
      { texture: this.word },
      { texture: this.slots, origin: [0, 0, Math.floor(this.values[0] / perWord)] },
      [this.size[0], this.size[1], 1],
    );
  }

  destroy(): void {
    for (const t of [this.slots, this.word, ...this.means]) t.destroy();
    this.uniform.destroy();
  }
}
