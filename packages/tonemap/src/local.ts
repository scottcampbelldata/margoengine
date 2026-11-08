/// <reference lib="esnext.disposable" preserve="true" />
// Local exposure for Tonemap: keeps detail in bright windows and dark interiors in one frame. The base and detail
// split of F. Durand and J. Dorsey, "Fast Bilateral Filtering for the Display of High-Dynamic-Range Images",
// SIGGRAPH 2002: log2 luminance is reduced to a quarter-resolution base by a bilateral filter (Tomasi and Manduchi,
// 1998), run as two separable passes (an approximation of the full 2D filter), and each pixel's exposure moves by
// -strength * (base + exposure - log2(0.18)) stops, clamped to +-maxStops. Only the smooth base is compressed; the
// detail on top of it (texture, edges inside a region) keeps its full contrast.
import type { TonemapExtension, TonemapPassContext } from './index.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Options of {@link LocalExposure}; the object is kept and read every frame. */
export interface LocalExposureOptions {
  /** How far each region's level moves toward middle grey, 0 (off) to 1 (flat). Default 0.5. */
  strength?: number;
  /** Largest local change, in stops, 0 to 8. Default 3. */
  maxStops?: number;
  /** Size of a region, as the blur's spatial sigma in fractions of the view height, 0.002 to 0.1. Default 0.02. */
  radius?: number;
  /** Edge stop of the bilateral blur, in stops of luminance, 0.1 to 8. Default 1.3. */
  edges?: number;
}

const SCALE = 4,
  TAPS = 32;

const quad = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);
}
`;
// Quarter resolution: the mean log2 luminance of each 4 by 4 block inside the image.
const downShader =
  quad +
  `@group(0) @binding(0) var scene:texture_2d<f32>;
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let size=vec2i(textureDimensions(scene));let o=vec2i(pos.xy)*${SCALE};var sum=0.0;var n=0.0;
  for(var y=0;y<${SCALE};y++){for(var x=0;x<${SCALE};x++){
    let q=o+vec2i(x,y);
    if(q.x<size.x&&q.y<size.y){
      let c=textureLoad(scene,q,0).rgb;let l=dot(max(c,vec3f(0)),vec3f(0.2126,0.7152,0.0722));
      sum+=clamp(log2(max(l,0.0001)),-14.0,14.0);n+=1.0;
    }
  }}
  return vec4f(sum/n,0,0,1);
}`;
// One direction of the bilateral blur: Gaussian in space (sigma s.x texels, taps to s.y) times Gaussian in log2
// luminance (sigma s.z stops); s.w is 0 for horizontal, 1 for vertical.
const blurShader =
  quad +
  `@group(0) @binding(0) var src:texture_2d<f32>;
@group(0) @binding(1) var<uniform> s:vec4f;
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let size=vec2i(textureDimensions(src));let p=vec2i(pos.xy);let c=textureLoad(src,p,0).r;
  let dir=select(vec2i(1,0),vec2i(0,1),s.w==1.0);var sum=0.0;var weight=0.0;
  for(var k=-i32(s.y);k<=i32(s.y);k++){
    let q=clamp(p+dir*k,vec2i(0),size-1);let v=textureLoad(src,q,0).r;let d=v-c;
    let w=exp(-f32(k*k)/(2.0*s.x*s.x)-d*d/(2.0*s.z*s.z));sum+=w*v;weight+=w;
  }
  return vec4f(sum/weight,0,0,1);
}`;

const local = (binding: number, extra: number) => `
@group(0) @binding(${binding}) var<uniform> localExposure:vec4f;
@group(0) @binding(${extra}) var localBase:texture_2d<f32>;
fn localStops(pos:vec2f,stops:f32)->f32 {
  let size=vec2i(textureDimensions(localBase));let t=pos/${SCALE}.0-0.5;let i=vec2i(floor(t));let f=fract(t);
  let a=textureLoad(localBase,clamp(i,vec2i(0),size-1),0).r;
  let b=textureLoad(localBase,clamp(i+vec2i(1,0),vec2i(0),size-1),0).r;
  let c=textureLoad(localBase,clamp(i+vec2i(0,1),vec2i(0),size-1),0).r;
  let d=textureLoad(localBase,clamp(i+vec2i(1,1),vec2i(0),size-1),0).r;
  let base=mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  return clamp(-localExposure.x*(base+stops-log2(0.18)),-localExposure.y,localExposure.y);
}`;

// The exposure line of each Tonemap shader variant; the local stops go right after it.
const EXPOSURE = /(hdr=max\(hdr,vec3f\(0\)\)\*(?:fx\.wb\.xyz\*)?exp2\(([^;]*)\);|hdr\*=(?:fx\.wb\.xyz\*)?exp2\(([^;]*)\);)/;

const inRange = (v: number | undefined, lo: number, hi: number) =>
  v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);

/**
 * Local exposure for {@link Tonemap}: brightens dark regions and darkens bright ones toward middle grey while keeping
 * the detail inside each region, so a bright window and a dark interior both hold detail. Give it to Tonemap's
 * `extensions`; change `local.options` any time. It adds three small render passes at quarter resolution before the
 * presentation pass and holds two `r32float` textures; dispose it (or `using`) when done.
 * @throws RangeError for an option out of range (checked now and every frame).
 */
export class LocalExposure implements TonemapExtension {
  readonly key = 'local';
  private readonly uniform = new Float32Array(4);
  private readonly blurValues = new Float32Array(8);
  private device?: GPUDevice;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private down?: GPURenderPipeline;
  private blur?: GPURenderPipeline;
  private blurBuffer?: GPUBuffer;
  private groups: GPUBindGroup[] = [];
  private source?: GPUTexture | GPUTextureView;
  constructor(readonly options: LocalExposureOptions = {}) {
    this.check();
  }
  patch(shader: string, binding: number, extra = binding + 1): string {
    const m = EXPOSURE.exec(shader);
    if (!m) throw new RangeError('LocalExposure: the Tonemap shader has no exposure step to follow; use LocalExposure only in Tonemap extensions.');
    const stops = m[2] ?? m[3];
    return shader.replace(m[1], `${m[1]}hdr*=exp2(localStops(pos.xy,${stops}));`) + local(binding, extra);
  }
  values(): Float32Array {
    this.check();
    const o = this.options;
    this.uniform[0] = o.strength ?? 0.5;
    this.uniform[1] = o.maxStops ?? 3;
    return this.uniform;
  }
  /** The quarter-resolution base, bound after the uniform. */
  resources(): GPUBindingResource[] {
    return this.views.length ? [this.views[2]] : [];
  }
  /** Builds the base for this frame: downsample, then the two blur directions. */
  encode(c: TonemapPassContext): void {
    const device = c.device,
      w = Math.max(1, Math.ceil(c.width / SCALE)),
      h = Math.max(1, Math.ceil(c.height / SCALE));
    if (this.device !== device) {
      this.release();
      this.device = device;
      const module = (code: string) => device.createShaderModule({ code }),
        pipeline = (code: string) => {
          const m = module(code);
          return device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: m, entryPoint: 'vertex' },
            fragment: { module: m, entryPoint: 'fragment', targets: [{ format: 'r32float' }] },
          });
        };
      this.down = pipeline(downShader);
      this.blur = pipeline(blurShader);
      // Two 16-byte slots, 256 bytes apart (the minimum uniform offset alignment).
      this.blurBuffer = device.createBuffer({ size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    if (this.textures[0]?.width !== w || this.textures[0]?.height !== h) {
      for (const t of this.textures) t.destroy();
      this.textures = [0, 1, 2].map(() =>
        device.createTexture({
          size: [w, h],
          format: 'r32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
      // 0: downsampled, 1: horizontal blur, 2: base (vertical blur).
      this.views = this.textures.map((t) => t.createView());
      this.groups = [];
    }
    if (!this.groups.length || this.source !== c.source) {
      this.source = c.source;
      const src = 'createView' in c.source ? c.source.createView() : c.source;
      this.groups = [
        device.createBindGroup({ layout: this.down!.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }] }),
        ...[0, 1].map((k) =>
          device.createBindGroup({
            layout: this.blur!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.views[k] },
              { binding: 1, resource: { buffer: this.blurBuffer!, offset: 256 * k, size: 16 } },
            ],
          }),
        ),
      ];
    }
    const o = this.options,
      sigma = Math.max(0.5, ((o.radius ?? 0.02) * c.height) / SCALE),
      v = this.blurValues;
    v[0] = v[4] = sigma;
    v[1] = v[5] = Math.min(TAPS, Math.ceil(3 * sigma));
    v[2] = v[6] = o.edges ?? 1.3;
    v[3] = 0;
    v[7] = 1;
    device.queue.writeBuffer(this.blurBuffer!, 0, v as Float32Array<ArrayBuffer>, 0, 4);
    device.queue.writeBuffer(this.blurBuffer!, 256, v as Float32Array<ArrayBuffer>, 4, 4);
    const passes: [GPURenderPipeline, GPUBindGroup, GPUTextureView][] = [
      [this.down!, this.groups[0], this.views[0]],
      [this.blur!, this.groups[1], this.views[1]],
      [this.blur!, this.groups[2], this.views[2]],
    ];
    for (const [pipeline, group, view] of passes) {
      const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
  }
  /** Frees the textures and buffer; the next frame makes them again. */
  dispose(): void {
    this.release();
  }
  [Symbol.dispose](): void {
    this.release();
  }
  private release(): void {
    for (const t of this.textures) t.destroy();
    this.blurBuffer?.destroy();
    this.textures = [];
    this.views = [];
    this.groups = [];
    this.device = this.down = this.blur = this.blurBuffer = this.source = undefined;
  }
  private check(): void {
    const o = this.options;
    if (
      !inRange(o.strength, 0, 1) ||
      !inRange(o.maxStops, 0, 8) ||
      !inRange(o.radius, 0.002, 0.1) ||
      !inRange(o.edges, 0.1, 8)
    )
      throw new RangeError(
        'Invalid LocalExposure options; strength is 0 to 1, maxStops 0 to 8, radius 0.002 to 0.1, edges 0.1 to 8.',
      );
  }
}
