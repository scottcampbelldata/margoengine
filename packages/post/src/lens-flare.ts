/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { render, compute, group as bind } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { PostStack } from './stack.js';
import { vertex } from './hiz.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
const WHITE = [1, 1, 1] as const;
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** One image of a {@link LensFlare} drawn on the line from the light through the screen centre. */
export interface LensFlareElement {
  /** The image (linear RGB; its alpha weights it, so a black or a transparent surround adds nothing), a 2D `GPUTexture`
   * of this engine's device with a filterable format such as `rgba8unorm`. Default none: a soft round glow. */
  texture?: GPUTexture;
  /** Width and height in pixels of the drawing buffer, greater than 0 and at most 8192. */
  size: number;
  /** Place on the line: 0 at the light, 0.5 at the screen centre, 1 at the light's mirror image through the centre. Any
   * finite value. Default 0. */
  distance?: number;
  /** Linear RGB tint, three finite values of 0 or more. Default [1, 1, 1]. */
  color?: readonly [number, number, number];
}

/** Options of {@link LensFlare}; all may change per frame. */
export interface LensFlareOptions {
  /** Direction toward the sun (x, y, z), and in w, when given, its strength (0 or less hides the flare). Default the
   * engine's light, `engine.lighting.direction`. With `@margoengine/sky`: `() => sky.lights[0].direction`. */
  sun?: () => ArrayLike<number>;
  /** A point light's world position (x, y, z), and in w, when given, its strength (0 or less hides the flare), in place
   * of `sun`: the flare starts at that point and hides behind anything drawn nearer. Pass one or the other. */
  position?: () => ArrayLike<number>;
  /** The images drawn, at most 16, of which at most 15 with a texture (each takes one sampled texture binding beside
   * the frame's, and a default device allows 16 per stage): they replace the built-in glow, halo and ghosts. Default
   * none: the built-in flare. */
  elements?: readonly LensFlareElement[];
  /** Linear RGB tint. Default the engine light's radiance for the sun, [1, 1, 1] for a `position`. */
  color?: readonly [number, number, number];
  /** Flare strength, 0-10, times the light's w. Default 0.1, or 1 with `elements` (each image at its own brightness). */
  intensity?: number;
  /** Radius in pixels of the disc of depth samples around the sun that decides how much of it is visible, 1-64. Default 12. */
  occlusionRadius?: number;
  /** False skips the effect (the scene passes through). Default true; also `lensFlare.enabled`. */
  enabled?: boolean;
}

// The sun's screen position as creative's god rays find it (a point far along its direction, through the camera's own
// matrix), so perspective and orthographic cameras alike; hidden behind the camera or outside the depth range. A point
// light (color.w 1) projects its own position the same way.
const uniforms = `
struct F {camera:mat4x4f,eye:vec4f,sun:vec4f,size:vec4f,color:vec4f}
@group(0) @binding(0) var<uniform> f:F;
struct Sun {pixel:vec2f,depth:f32,valid:bool}
fn sunPosition()->Sun {
let clip=f.camera*vec4f(select(f.eye.xyz+f.sun.xyz*f.eye.w,f.sun.xyz,f.color.w>0.5),1.0);
if(clip.w<=0.0||f.sun.w<=0.0){return Sun(vec2f(0),0.0,false);}
let n=clip.xyz/clip.w;
return Sun(vec2f(n.x*0.5+0.5,0.5-n.y*0.5)*f.size.xy,n.z,n.z>=0.0&&n.z<=1.0);
}
`;
// Visible share of the sun: an 8 x 8 grid of depth samples over a disc around it; a sample sees the sun where the depth
// buffer holds nothing nearer than the sun's own point (reversed-Z: smaller is farther). Off-screen samples are left out;
// with none on screen the sun counts as visible. Times a fade as the sun leaves the screen.
const occlusionShader =
  uniforms +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var<storage,read_write> visible:array<f32>;
@compute @workgroup_size(1) fn main() {
let s=sunPosition();if(!s.valid){visible[0]=0.0;return;}
let size=vec2i(f.size.xy);var open=0.0;var count=0.0;
for(var y=0;y<8;y++){for(var x=0;x<8;x++){
let o=(vec2f(f32(x),f32(y))+0.5)/4.0-1.0;if(dot(o,o)>1.0){continue;}
let q=vec2i(floor(s.pixel+o*f.size.z));if(any(q<vec2i(0))||any(q>=size)){continue;}
count+=1.0;if(textureLoad(depth,q,0)<=s.depth){open+=1.0;}
}}
let outside=max(max(-s.pixel.x,s.pixel.x-f.size.x)/f.size.x,max(-s.pixel.y,s.pixel.y-f.size.y)/f.size.y);
visible[0]=select(1.0,open/count,count>0.0)*clamp(1.0-4.0*max(outside,0.0),0.0,1.0);
}`;
// Elements (layout: 't' textured, '-' a soft round glow, one character each): each is a square of its size in pixels
// centred on the flare line at its distance (0 the light, 1 its mirror image through the screen centre), added in.
const elementLight = (layout: string) => {
  let k = 0,
    code =
      'let p=frag.xy;let mirror=f.size.xy-sun.pixel;var light=vec3f(0.0);var e=vec4f(0.0);var uv=vec2f(0.0);var r=0.0;';
  for (let i = 0; i < layout.length; i++)
    code +=
      `e=elements[${2 * i}];uv=(p-mix(sun.pixel,mirror,e.x))/e.y+0.5;if(all(abs(uv-0.5)<=vec2f(0.5))){` +
      (layout[i] === 't'
        ? `let t=textureSampleLevel(image${k++},flareSampler,uv,0.0);light+=t.rgb*t.a*elements[${2 * i + 1}].rgb;}`
        : `r=min(length(uv-0.5)*2.0,1.0);light+=(1.0-r)*(1.0-r)*elements[${2 * i + 1}].rgb;}`);
  return code;
};
const elementBindings = (layout: string) => {
  const textured = layout.split('t').length - 1;
  let code = '@group(0) @binding(3) var<storage,read> elements:array<vec4f>;';
  if (textured) code += '@group(0) @binding(4) var flareSampler:sampler;';
  for (let k = 0; k < textured; k++) code += `@group(0) @binding(${5 + k}) var image${k}:texture_2d<f32>;`;
  return code;
};
// The built-in flare, added to the scene: a glow around the sun, a halo ring about the screen centre on the sun's side,
// and six ghosts (the lens's internal reflections) on the line from the sun through the centre, at fixed fractions.
const flareShader = (hdr: boolean, layout: string) =>
  vertex +
  uniforms +
  `
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> visible:array<f32>;
${layout ? elementBindings(layout) : ''}
${hdr ? '' : displayShader}
const GHOSTS=array<vec4f,6>(vec4f(0.45,0.02,0.6,0.0),vec4f(-0.25,0.05,0.35,1.0),vec4f(-0.55,0.03,0.5,2.0),vec4f(-0.85,0.08,0.25,3.0),vec4f(-1.15,0.04,0.4,4.0),vec4f(-1.6,0.12,0.15,5.0));
const TINTS=array<vec3f,6>(vec3f(1.0,0.8,0.5),vec3f(0.5,0.8,1.0),vec3f(1.0,0.55,0.3),vec3f(0.55,1.0,0.6),vec3f(0.8,0.5,1.0),vec3f(0.4,0.6,1.0));
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let s=textureLoad(scene,q,0);var c=s.rgb;let v=visible[0];let sun=sunPosition();
if(v>0.0&&sun.valid&&f.size.w>0.5){
${layout ? elementLight(layout) : `let h=f.size.y;let p=frag.xy;let centre=f.size.xy*0.5;let axis=sun.pixel-centre;let d=distance(p,sun.pixel);
var light=(exp(-d/(0.012*h))*0.8+exp(-d/(0.08*h))*0.2)*vec3f(1.0);
let ring=distance(p,centre);let side=max(dot(normalize(p-centre+vec2f(1e-4)),normalize(axis+vec2f(1e-4))),0.0);
light+=vec3f(0.5,0.7,1.0)*0.08*exp(-pow((ring-0.42*h)/(0.012*h),2.0))*side*side;
for(var i=0;i<6;i++){
let g=GHOSTS[i];let r=g.y*h;let e=distance(p,centre+axis*g.x)/r;
light+=TINTS[i]*g.z*(1.0-smoothstep(0.8,1.0,e))*(0.6+0.4*e*e);
}`}
c+=light*f.color.rgb*f.sun.w*v;
}
return vec4f(${hdr ? 'c' : 'toDisplay(c)'},s.a);
}`;

/**
 * A lens flare in a {@link PostStack} (HDR effect), from the sun's direction or a point light's `position`: a glow, a
 * halo and ghosts along the line through the screen centre, or your own `elements` (images at sizes and places on that
 * line), added to the frame. A disc of depth samples around the projected light (the stack's depth) hides it behind
 * geometry, in part where geometry covers part of the disc. `LensFlare.attach` runs it alone.
 */
export class LensFlare implements EnginePlugin {
  readonly name = 'lens-flare';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private uniform?: GPUBuffer;
  private visible?: GPUBuffer;
  private occlusion?: GPUComputePipeline;
  private occlusionGroup?: GPUBindGroup;
  private depthTexture?: GPUTexture;
  private composite?: GPURenderPipeline;
  private compositeGroup?: GPUBindGroup;
  private input?: GPUTextureView;
  private key = '';
  private elementBuffer?: GPUBuffer;
  private sampler?: GPUSampler;
  private images: GPUTexture[] = [];
  private readonly values = new Float32Array(36);
  private readonly elementValues = new Float32Array(128);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly pass: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: LensFlareOptions = {}) {
    this.validate();
  }
  /** Alone, LensFlare runs in its own one-effect PostStack; to combine it, put it in your PostStack (after SSR, before Bloom). */
  static attach(engine: EngineKernel, options: LensFlareOptions = {}): LensFlare {
    const effect = new LensFlare(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('LensFlare enabled must be boolean');
    this.options.enabled = value;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'LensFlare is already attached; create another LensFlare for another stack');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      i = o.intensity ?? 1,
      r = o.occlusionRadius ?? 12,
      rgb = (c?: readonly number[]) => c === undefined || (c.length === 3 && c.every((v) => v >= 0 && Number.isFinite(v))),
      elements = o.elements;
    if (
      (o.sun !== undefined && typeof o.sun !== 'function') ||
      (o.position !== undefined && (typeof o.position !== 'function' || o.sun !== undefined)) ||
      !rgb(o.color) ||
      !(i >= 0 && i <= 10) ||
      !(r >= 1 && r <= 64) ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean') ||
      (elements !== undefined &&
        (!Array.isArray(elements) ||
          elements.length > 16 ||
          elements.filter((e) => e?.texture !== undefined).length > 15 ||
          elements.some(
            (e) =>
              !((e?.size ?? 0) > 0 && e.size <= 8192) ||
              !Number.isFinite(e.distance ?? 0) ||
              !rgb(e.color) ||
              (e.texture !== undefined && typeof e.texture?.createView !== 'function'),
          )))
    )
      throw new RangeError(
        'Invalid LensFlare options; sun or position (not both) must be a function, color three finite values >= 0, intensity 0-10, occlusionRadius 1-64, elements at most 16 (at most 15 with a texture) with size in (0, 8192], a finite distance and a GPUTexture texture.',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'LensFlare is disposed; create a new LensFlare');
    if (!this.host)
      throw margoError(
        'state',
        'LensFlare runs in a PostStack: use LensFlare.attach(engine) or PostStack.attach(engine, [..., new LensFlare()])',
      );
    if (!engine.gpu) throw margoError('unsupported', 'LensFlare requires WebGPU');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.visible = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    this.occlusion = compute(engine.gpu, occlusionShader);
  }
  private stage(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const o = this.options,
      v = this.values,
      lighting = this.engine!.lighting,
      point = o.position ? o.position() : undefined,
      sun = point ?? (o.sun ? o.sun() : lighting.direction),
      color = o.color ?? (point ? WHITE : lighting.radiance),
      elements = o.elements;
    if (o.position) {
      if (!point || point.length < 3 || !Number.isFinite(point[0] + point[1] + point[2]))
        throw margoError('state', 'LensFlare position must give a finite point (x, y, z[, strength])');
    } else if (!sun || sun.length < 3 || !(Math.hypot(sun[0], sun[1], sun[2]) > 0))
      throw margoError('state', 'LensFlare sun must give a nonzero direction (x, y, z[, strength])');
    v.set(c.camera.matrix);
    v.set(c.camera.position, 16);
    // The sun's point: halfway to the far plane along its direction (any point on that ray projects alike in perspective).
    v[19] = c.camera.far * 0.5;
    // The unit direction, normalized here: shaders never normalize a uniform-only light value (core's frame light).
    const k = point ? 1 : Math.hypot(sun[0], sun[1], sun[2]);
    for (let i = 0; i < 3; i++) v[20 + i] = sun[i] / k;
    v[23] = (sun.length > 3 ? Math.max(0, sun[3]) : 1) * (o.intensity ?? (elements?.length ? 1 : 0.1));
    v[24] = c.width;
    v[25] = c.height;
    v[26] = o.occlusionRadius ?? 12;
    v[27] = +this.enabled;
    v[28] = color[0];
    v[29] = color[1];
    v[30] = color[2];
    v[31] = point ? 1 : 0;
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    let layout = '';
    if (elements?.length) {
      // Two vec4 per element: distance and size, then the tint; written only while elements are set.
      const e = this.elementValues.fill(0);
      elements.forEach((element, i) => {
        e[8 * i] = element.distance ?? 0;
        e[8 * i + 1] = element.size;
        e.set(element.color ?? WHITE, 8 * i + 4);
        layout += element.texture ? 't' : '-';
      });
      this.elementBuffer ??= c.device.createBuffer({
        size: 512,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      c.device.queue.writeBuffer(this.elementBuffer, 0, e, 0, Math.max(8, 8 * elements.length));
    }
    const depth = this.host!.depthTexture!;
    if (this.depthTexture !== depth) {
      this.depthTexture = depth;
      this.occlusionGroup = bind(c.device, this.occlusion!, [
        { buffer: this.uniform! },
        depth.createView({ aspect: 'depth-only' }),
        { buffer: this.visible! },
      ]);
    }
    if (this.enabled && v[23] > 0) {
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(this.occlusion!);
      pass.setBindGroup(0, this.occlusionGroup!);
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    const key = output.format + output.multisample.count + output.hdr + layout;
    if (this.key !== key) {
      this.key = key;
      this.composite = render(c.device, flareShader(output.hdr, layout), output.format, {
        multisample: output.multisample,
      });
      this.input = undefined;
    }
    const images = elements?.flatMap((element) => (element.texture ? [element.texture] : [])) ?? [];
    if (this.input !== input || images.some((image, i) => image !== this.images[i])) {
      this.input = input;
      this.images = images;
      const resources: (GPUBufferBinding | GPUTextureView | GPUSampler)[] = [
        { buffer: this.uniform! },
        input,
        { buffer: this.visible! },
      ];
      if (layout) resources.push({ buffer: this.elementBuffer! });
      if (images.length)
        resources.push(
          (this.sampler ??= c.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })),
          ...images.map((image) => image.createView()),
        );
      this.compositeGroup = bind(c.device, this.composite!, resources);
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.pass);
    pass.setPipeline(this.composite!);
    pass.setBindGroup(0, this.compositeGroup!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.visible?.destroy();
    this.elementBuffer?.destroy();
    this.uniform = this.visible = this.elementBuffer = undefined;
    this.sampler = undefined;
    this.images = [];
    this.occlusion = this.composite = undefined;
    this.occlusionGroup = this.compositeGroup = undefined;
    this.depthTexture = this.input = undefined;
    this.key = '';
    this.attachment.view = undefined!;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stack = this.stack;
    this.stack = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    stack?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
