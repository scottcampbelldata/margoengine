/// <reference lib="esnext.disposable" preserve="true" />
// Screen-space mesh blending, an HDR PostStack stage: softens the hard seam where a tagged mesh meets another surface
// (a rock on terrain). Clean room from published descriptions (docs/clean-room.md, "Mesh blending"): tagged meshes
// write a key and their blend radius into an id target (the per-object id buffer of the screen-space seam blenders,
// Tollenaar), a post pass samples a golden-angle spiral (Vogel 1979) out to the radius for the nearest pixel of another
// surface, refines the crossing by bisection, and mixes in the colour mirrored across the seam, half at the seam and none at the radius
// (Tollenaar's mirror; the depth fade of soft particles, Lorach 2007). A crossing where the two sides' depths, each carried
// to the seam along its own slope, do not meet is a silhouette, not a contact, and is rejected (the depth-range test
// of bilateral filtering, Tomasi & Manduchi 1998, against depths extrapolated along each side's own slope, the
// slope-scaled bias of Williams 1978), so a rock's top against far ground or the sky never smears.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { meshRuntime, type FrameGraph } from '@margoengine/core/extension';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen, meshVertex } from '../../shared/gpu.js';
import { displayFor, displayShader } from '../../shared/display.js';
import { orthographic } from '../../shared/projection.js';
import { margoError } from '../../shared/errors.js';
import { captureModel, drawCapture } from '../../shared/capture.js';
import type { SSRCapture, SSRModel } from './ssr.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };

/** Options of {@link MeshBlend}; the object is kept and read every frame. */
export interface MeshBlendOptions {
  /** Largest blend reach on screen, whole pixels 1 to 128; a nearby mesh's radius is cut to this. Default 32. */
  maxPixels?: number;
  /**
   * Search samples per pixel, 4 to 64, on a golden-angle spiral over the reach; the nearest sample on another surface
   * is refined to the seam by 5 bisection steps. More finds thin seams further out. Default 32.
   */
  samples?: number;
  /**
   * Depth-slope rejection: the largest depth jump across a seam, beyond what the near side's own slope predicts, that
   * still counts as touching, as a share of the blend radius; above 0. Smaller rejects more. Default 0.5.
   */
  depthTolerance?: number;
  /** Share of the blend applied, 0 to 1. Default 1. */
  strength?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
  /** Frame-graph order of the tag pass: after the main pass (0), before the stack composes (30). Default 20. */
  order?: number;
}

/** Inputs of {@link meshBlendWeight}, all along one search direction from the pixel being shaded. */
export interface MeshBlendSample {
  /** Pixels from the shaded pixel to the seam, 0 or more. */
  distance: number;
  /** Blend radius of the seam in pixels (the larger radius of the two meshes); 0 or less blends nothing. */
  radius: number;
  /** World-unit depth jump across the seam beyond the slope prediction, as {@link meshBlendGap} gives it. */
  gap: number;
  /** World-unit gap at which the blend is fully rejected (`depthTolerance` times the world radius); above 0. */
  tolerance: number;
}

/**
 * The share of the colour across the seam that MeshBlend mixes into a pixel, the same maths as its shader: 0.5 at the
 * seam falling smoothly to 0 at the radius, times a depth-slope rejection that is 1 below half the tolerance and 0 at
 * it. `meshBlendWeight({distance: 0, radius: 8, gap: 0, tolerance: 0.1})` is 0.5.
 */
export function meshBlendWeight({ distance, radius, gap, tolerance }: MeshBlendSample): number {
  if (!(radius > 0) || !(distance < radius)) return 0;
  return 0.5 * (1 - smooth(0, 1, Math.max(distance, 0) / radius)) * (1 - smooth(0.5 * tolerance, tolerance, gap));
}
/**
 * The depth jump across a seam that MeshBlend's depth-slope rejection tests, the same maths as its shader: each side's
 * view distance is carried half the `span` pixels between the last pixel of one side and the first of the other along
 * that side's own slope per pixel, and the two must meet. A vertical face meeting ground seen at a grazing angle meets
 * (0); a face in front of far ground does not. `near` is [one pixel before, last pixel] of the shaded side, `far`
 * [first pixel, one pixel after] of the other side; give a side the same distance twice when its slope is unknown.
 */
export function meshBlendGap(near: readonly [number, number], far: readonly [number, number], span: number): number {
  return Math.abs(near[1] + ((near[1] - near[0]) * span) / 2 - (far[0] - ((far[1] - far[0]) * span) / 2));
}
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// The tag pass: every core mesh writes its depth; tagged ones their radius (r), their key (entity id + 1 split into two
// float16-exact halves, g and b) and alpha 1, untagged ones alpha 0.5. Radii are read by entity id from a 256-wide table.
const tagFragment = `@group(0) @binding(1) var radii:texture_2d<f32>;
@fragment fn fragment(i:Output)->@location(0) vec4f {
 let r=textureLoad(radii,vec2i(i32(i.id%256u),i32(i.id/256u)),0).r;
 if(r<=0){return vec4f(0,0,0,0.5);}
 let k=i.id+1u;
 return vec4f(r,f32(k%2048u),f32(k/2048u),1);
}`;

// The key pass resolves each pixel once: a = -1 sky (no depth), 0 an untagged surface, 1 a tagged mesh, with its
// radius and key halves in rgb. A tag pass surface counts only where its depth matches the scene's within 0.2% and one
// pixel's depth span (the smaller step to a neighbour on each axis), so anything drawn in front of a tagged mesh (an
// untagged mesh, terrain, a glTF model) hides its tag. The scene's resolved depth holds the nearest of a pixel's
// samples while the 1x tag pass holds its centre: a silhouette pixel mostly covered by the sky can carry a mesh's depth
// with no surface of the tag pass matching at its centre. Such a pixel, and only such a pixel, takes a neighbour's tag
// whose depth matches its own within 0.2% and that neighbour's own depth span: a silhouette pixel lies on the mesh's
// face, while ground meeting the mesh (drawn or not by the tag pass) lies a pixel of its own slope away.
// u.z: distance from reversed-Z depth as (x + y d) / (z + w d). u.p: world size of a pixel at distance 1 (or always,
// orthographic), orthographic flag, maxPixels, depthTolerance. u.q: strength, samples, largest tagged radius, on.
const common = `struct U {z:vec4f,p:vec4f,q:vec4f}
@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var<uniform> u:U;
fn away(d:f32)->f32 {return abs((u.z.x+u.z.y*d)/(u.z.z+u.z.w*d));}
`;
const keyShader = `${fullscreen}${common}
@group(0) @binding(2) var tags:texture_2d<f32>;
@group(0) @binding(3) var tagDepth:texture_depth_2d;
fn tagAt(q:vec2i,w:f32,slack:f32)->vec4f {
 let c=clamp(q,vec2i(0),vec2i(textureDimensions(tags))-1);let t=textureLoad(tags,c,0);
 if(t.a>0&&abs(away(textureLoad(tagDepth,c,0))-w)<=slack){return vec4f(t.rgb,select(0.0,1.0,t.a>0.75));}
 return vec4f(0,0,0,-1);
}
fn at(q:vec2i)->f32 {return away(textureLoad(depth,clamp(q,vec2i(0),vec2i(textureDimensions(depth))-1),0));}
fn spanAt(p:vec2i)->f32 {let w=at(p);return min(abs(w-at(p-vec2i(1,0))),abs(at(p+vec2i(1,0))-w))+min(abs(w-at(p-vec2i(0,1))),abs(at(p+vec2i(0,1))-w));}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
 let p=vec2i(pos.xy);let d=textureLoad(depth,p,0);
 if(d<=0){return vec4f(0,0,0,-1);}
 let w=away(d);
 let span=spanAt(p);
 let own=tagAt(p,w,w*0.002+span+1e-5);
 if(own.a>=0){return own;}
 for(var i=0;i<9;i++){
  let q=p+vec2i(i%3-1,i/3-1);let k=tagAt(q,w,w*0.002+spanAt(q)+1e-5);
  if(i!=4&&k.a>0){return k;}
 }
 return vec4f(0);
}`;
// key(q): x -2 off screen, -1 sky, 0 an untagged surface, above 0 a tagged mesh's key; y its world radius; z its view
// distance.
// A tagged gltf/pbr model or terrain draws through the capture hook SceneTargets and SSR use: its own material and
// depth, with one constant output, its radius and key (keys counted down from the top of the range, so they never meet
// a core mesh's entity id + 1).
const KEY_TOP = 2048 * 2048 - 1;
// gltf/pbr and materials shaders declare the PBR `Surface` (water's own `Surface` starts with its position). Terrain
// writes `struct Frame {camera`, core's lit shader (which lit scatter extends) `struct Frame { camera`, water the same
// camera and eye: those return `margoSSR(n, v, base, metal, rough)`.
const pbrSurface = /struct Surface \{\s*base:vec4f\b/;
const terrainFrame = /struct Frame \{\s*camera:mat4x4f,eye:vec4f,/;
const captureCode = (code: string, value: string): string => {
  if (pbrSurface.test(code))
    return `struct MargoCapture {@location(0) o0:vec4f}\nfn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {_=s.n;_=v;_=k;return MargoCapture(${value});}\n`;
  if (terrainFrame.test(code))
    return `struct MargoSSR {@location(0) o0:vec4f}\nfn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {_=n;_=v;_=base;_=metal;_=rough;return MargoSSR(${value});}\n`;
  throw margoError(
    'unsupported',
    'MeshBlend tags core meshes, gltf/pbr models, materials meshes, terrain, lit scatters and water only',
  );
};
type Tagged = { radius: number; hook: SSRCapture; release: () => void };

const shader = (encode: boolean) => `${fullscreen}${encode ? displayShader : ''}${common}
@group(0) @binding(2) var scene:texture_2d<f32>;
@group(0) @binding(3) var keys:texture_2d<f32>;
fn key(q:vec2i)->vec3f {
 let top=vec2i(textureDimensions(depth))-1;
 if(any(q<vec2i(0))||any(q>top)){return vec3f(-2,0,0);}
 let k=textureLoad(keys,q,0);
 if(k.a<0){return vec3f(-1,0,0);}
 return vec3f(select(0.0,k.g+k.b*2048,k.a>0),k.r,away(textureLoad(depth,q,0)));
}
fn along(p:vec2i,d:vec2f,t:f32)->vec2i {return p+vec2i(round(d*t));}
fn weight(s:f32,r:f32,gap:f32,tol:f32)->f32 {
 if(r<=0||s>=r){return 0.0;}
 return 0.5*(1-smoothstep(0,1,max(s,0)/r))*(1-smoothstep(0.5*tol,tol,gap));
}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
 let p=vec2i(pos.xy);let now=textureLoad(scene,p,0);
 let a=key(p);
 var rgb=now.rgb;
 if(a.x>=0&&u.q.w>0){
  let scale=u.p.x*select(a.z,1.0,u.p.y>0);
  let reach=min(u.p.z,u.q.z/scale);
  var best=0.0;var other=now.rgb;var tries=0;
  for(var i=0.0;i<u.q.y&&reach>=1&&tries<4;i+=1){
   let t=reach*sqrt((i+0.5)/u.q.y);let turn=i*2.39996323;let d=vec2f(cos(turn),sin(turn));
   let b0=key(along(p,d,t));
   if(b0.x<0||b0.x==a.x){continue;}
   tries++;
   var lo=0.0;var hi=t;
   for(var k=0;k<5;k++){let m=(lo+hi)*0.5;if(key(along(p,d,m)).x==a.x){lo=m;}else{hi=m;}}
   let b=key(along(p,d,hi));
   let r=max(select(0.0,a.y,a.x>0),select(0.0,b.y,b.x>0));
   if(b.x<0||r<=0){continue;}
   let ns=key(along(p,d,lo));let nb=key(along(p,d,lo-1));
   let slope=select(0.0,ns.z-nb.z,nb.x==a.x&&ns.x==a.x);
   let w0=select(a.z,ns.z,ns.x==a.x);
   let nf=key(along(p,d,hi+1));let fs=select(0.0,nf.z-b.z,nf.x==b.x);
   let span=hi-lo;
   let gap=abs(w0+slope*span*0.5-(b.z-fs*span*0.5));
   let w=weight((lo+hi)*0.5,min(u.p.z,r/scale),gap,u.p.w*r);
   if(w>0){
    best=w;let mirror=along(p,d,lo+hi);
    other=textureLoad(scene,select(along(p,d,hi),mirror,key(mirror).x==b.x),0).rgb;
    break;
   }
  }
  rgb=mix(now.rgb,other,best*u.q.x);
 }
 return vec4f(${encode ? 'toDisplay(rgb)' : 'rgb'},now.a);
}`;

/**
 * Mesh blending in a PostStack (HDR effect): softens the seam where a tagged mesh meets another surface, such as rocks
 * set into terrain, by mixing in the colour mirrored across the seam within the mesh's blend radius. `tag(mesh,
 * radius)` picks the meshes and their radius in world units; seams between untagged surfaces stay sharp, and a seam
 * whose depth jumps (a silhouette against far ground or the sky) is rejected. Place it before Tonemap. Core meshes are
 * tagged (a tag on a parent covers its child meshes), and so are gltf/pbr models, materials meshes and terrain.
 * ```ts
 * const blend = MeshBlend.attach(engine);
 * blend.tag(rock, 0.3);
 * ```
 * @throws TypeError or RangeError when an option or tag is invalid (options are checked every frame); MargoError
 * `'state'` outside a PostStack, `'unsupported'` without a GPU, `'disposed'` after `dispose()`, `'attached'` when
 * joined twice.
 */
export class MeshBlend extends ScreenEffect {
  readonly name = 'mesh-blend';
  protected readonly kind = 'hdr';
  private readonly tagged = new Map<Mesh, number>();
  private readonly models = new Map<SSRModel, Tagged>();
  private readonly captures = new Map<SSRModel, () => void>();
  private serial = 0;
  private context?: ScreenContext;
  private pass?: GPURenderPassEncoder;
  private readonly values = new Float32Array(12);
  private tagTexture?: GPUTexture;
  private tagView?: GPUTextureView;
  private tagDepthTexture?: GPUTexture;
  private tagDepthView?: GPUTextureView;
  private tagDepthSample?: GPUTextureView;
  private radii?: GPUTexture;
  private radiiView?: GPUTextureView;
  private table = new Float32Array(0);
  private tagPipeline?: GPURenderPipeline;
  private tagDescriptor?: GPURenderPipelineDescriptor;
  private single?: GPURenderPipelineDescriptor;
  private depthSource?: GPUTexture;
  private depthView?: GPUTextureView;
  private readonly keys: StageOutput = {
    view: undefined!,
    format: 'rgba16float',
    multisample: { count: 1 },
    hdr: true,
  };

  constructor(readonly options: MeshBlendOptions = {}) {
    super();
    this.check();
  }

  /** Attaches a new MeshBlend to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: MeshBlendOptions = {}): MeshBlend {
    const effect = new MeshBlend(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  /**
   * Blends the seams of `target` within `radius` world units, above 0: a core mesh (and its child meshes), or a gltf/pbr
   * model, materials mesh or terrain (drawn with its own material through the capture hook). Tagging again changes
   * the radius. Returns a remover. Two tagged surfaces that touch blend with the larger radius.
   */
  tag(target: Mesh | SSRModel, radius: number): () => void {
    if (!target || typeof target !== 'object')
      throw new TypeError('MeshBlend.tag needs a core mesh, gltf/pbr model, materials mesh or terrain');
    if (!(Number.isFinite(radius) && radius > 0 && radius <= 65504))
      throw new RangeError('MeshBlend.tag radius must be finite, above 0 and at most 65504 world units');
    if (typeof (target as SSRModel).setCapture !== 'function') {
      this.tagged.set(target as Mesh, radius);
      return () => this.untag(target);
    }
    const model = target as SSRModel;
    this.untag(model);
    const key = KEY_TOP - (this.serial++ % 65536),
      value = `vec4f(${radius},${key % 2048}.0,${Math.floor(key / 2048)}.0,1.0)`,
      cache = new Map<string, string>(),
      hook: SSRCapture = {
        targets: [{ format: 'rgba16float' }],
        declarations: (code) => {
          let out = cache.get(code);
          if (out === undefined) {
            if (cache.size >= 64) cache.clear();
            cache.set(code, (out = captureCode(code, value)));
          }
          return out;
        },
        begin: () => this.begin(),
      };
    const release = captureModel(this.captures, model, hook);
    this.models.set(model, { radius, hook, release });
    return () => this.untag(model);
  }

  /** Stops blending the seams of `target`; true when it was tagged. */
  untag(target: Mesh | SSRModel): boolean {
    const model = this.models.get(target as SSRModel);
    if (!model) return this.tagged.delete(target as Mesh);
    this.models.delete(target as SSRModel);
    model.release();
    return true;
  }

  /** The tagged meshes and models and their radii (a copy). */
  get tags(): ReadonlyMap<Mesh | SSRModel, number> {
    const out = new Map<Mesh | SSRModel, number>(this.tagged);
    for (const [model, { radius }] of this.models) out.set(model, radius);
    return out;
  }

  /** The tag pass for models, opened on the first model's draw and ended after the last. */
  private begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!,
      pass = (this.pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: this.tagView!, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: this.tagDepthView!, depthLoadOp: 'load', depthStoreOp: 'store' },
      })),
      rect = c.view?.viewport;
    if (rect) {
      pass.setViewport(rect[0], rect[1], rect[2], rect[3], 0, 1);
      const scissor = c.view!.scissor ?? rect;
      pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
    }
    return pass;
  }

  protected check(): void {
    const o = this.options,
      whole = (value: number | undefined, top: number) =>
        value === undefined || (Number.isInteger(value) && value >= 1 && value <= top);
    if (!whole(o.maxPixels, 128)) throw new RangeError('MeshBlend maxPixels must be a whole number from 1 to 128');
    if (!whole(o.samples, 64) || (o.samples ?? 32) < 4)
      throw new RangeError('MeshBlend samples must be a whole number from 4 to 64');
    if (o.depthTolerance !== undefined && !(Number.isFinite(o.depthTolerance) && o.depthTolerance > 0))
      throw new RangeError('MeshBlend depthTolerance must be finite and above 0; pass a share of the radius');
    if (o.strength !== undefined && !(o.strength >= 0 && o.strength <= 1))
      throw new RangeError('MeshBlend strength must be in 0..1');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('MeshBlend enabled must be a boolean; pass true or false');
    if (o.order !== undefined && !Number.isFinite(o.order))
      throw new TypeError('MeshBlend order must be a finite number; pass a frame-graph order');
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'mesh-blend:tags',
      order: this.options.order ?? 20,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawTags(c);
      },
    });
  }

  private ensure(c: ScreenContext): void {
    if (this.tagTexture?.width === c.width && this.tagTexture.height === c.height) return;
    this.releaseTags();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.tagTexture = c.device.createTexture({ size: [c.width, c.height], format: 'rgba16float', usage });
    this.tagDepthTexture = c.device.createTexture({ size: [c.width, c.height], format: 'depth32float', usage });
    this.tagView = this.tagTexture.createView();
    this.tagDepthView = this.tagDepthTexture.createView();
    this.tagDepthSample = this.tagDepthTexture.createView({ aspect: 'depth-only' });
  }

  /** Fills the radius table by entity id: a mesh takes the radius of its nearest tagged ancestor (itself first). */
  private fillRadii(c: ScreenContext): number {
    const engine = this.engine!,
      capacity = engine.store.capacity,
      rows = Math.max(1, Math.ceil(capacity / 256));
    if (this.table.length !== rows * 256) {
      this.radii?.destroy();
      this.table = new Float32Array(rows * 256);
      this.radii = c.device.createTexture({
        size: [256, rows],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.radiiView = this.radii.createView();
    }
    const table = this.table,
      byId = new Map<number, number>();
    table.fill(0);
    for (const [mesh, radius] of this.tagged) byId.set(meshRuntime(mesh).id, radius);
    let largest = 0;
    if (byId.size)
      for (const mesh of engine.meshes.values())
        for (let id = mesh.id; id !== -1; id = engine.store.parents[id]) {
          const radius = byId.get(id);
          if (radius !== undefined) {
            table[mesh.id] = radius;
            largest = Math.max(largest, radius);
            break;
          }
        }
    c.device.queue.writeTexture({ texture: this.radii! }, table, { bytesPerRow: 1024 }, [256, rows]);
    return largest;
  }

  private largest = 0;

  private drawTags(c: ScreenContext): void {
    if (!this.engine) return;
    this.check();
    this.ensure(c);
    c.encoder
      .beginRenderPass({
        colorAttachments: [
          { view: this.tagView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: this.tagDepthView!,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    let largest = this.options.enabled === false ? 0 : this.fillRadii(c);
    if (this.options.enabled !== false)
      for (const { radius } of this.models.values()) largest = Math.max(largest, radius);
    this.largest = largest;
    if (!this.largest) return;
    if (this.tagDescriptor !== c.descriptor || !this.tagPipeline) {
      this.tagDescriptor = c.descriptor;
      const module = c.device.createShaderModule({ code: meshVertex + tagFragment });
      this.single = {
        ...c.descriptor,
        multisample: { count: 1 },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      };
      this.tagPipeline = c.device.createRenderPipeline({
        ...this.single,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      });
    }
    const { color, depth, descriptor } = c;
    c.color = this.tagView!;
    c.depth = this.tagDepthView!;
    c.descriptor = this.single!;
    try {
      c.draw({
        pipeline: this.tagPipeline,
        clear: false,
        clearDepth: false,
        bindings: [{ binding: 1, resource: this.radiiView! }],
      });
      this.context = c;
      for (const [model, { hook }] of this.models) drawCapture(model, hook, c);
    } finally {
      this.pass?.end();
      this.pass = this.context = undefined;
      Object.assign(c, { color, depth, descriptor });
    }
  }

  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      v = this.values,
      m = c.camera.matrix,
      eye = orthographic(m, c.camera.position);
    this.ensure(c);
    v.set(
      eye
        ? [eye.far, eye.near - eye.far, 1, 0]
        : [c.camera.near * c.camera.far, 0, c.camera.near, c.camera.far - c.camera.near],
    );
    // A pixel's world size at view distance 1 (perspective) or anywhere (orthographic): 2 / (clip y scale * height).
    v.set([2 / (Math.hypot(m[1], m[5], m[9]) * c.height), eye ? 1 : 0, o.maxPixels ?? 32, o.depthTolerance ?? 0.5], 4);
    v.set([o.strength ?? 1, o.samples ?? 32, this.largest, +(o.enabled !== false && this.largest > 0)], 8);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    const depth = this.host!.depthTexture!;
    if (depth !== this.depthSource) {
      this.depthSource = depth;
      this.depthView = depth.createView({ aspect: 'depth-only' });
    }
    const keys = this.keys;
    keys.view = this.target(c, 0);
    this.draw(c, keyShader, keys, [this.depthView!, { buffer: this.uniform! }, this.tagView!, this.tagDepthSample!]);
    this.draw(c, displayFor(this.engine, shader(!output.hdr)), output, [
      this.depthView!,
      { buffer: this.uniform! },
      input,
      keys.view,
    ]);
  }

  private releaseTags(): void {
    this.tagTexture?.destroy();
    this.tagDepthTexture?.destroy();
    this.tagTexture = this.tagDepthTexture = this.tagView = this.tagDepthView = this.tagDepthSample = undefined;
  }

  protected override release(): void {
    super.release();
    this.releaseTags();
    this.radii?.destroy();
    this.radii = this.radiiView = this.tagPipeline = this.tagDescriptor = this.single = undefined;
    this.depthSource = this.depthView = undefined;
    this.table = new Float32Array(0);
    this.largest = 0;
  }

  override dispose(): void {
    for (const { release } of this.models.values()) release();
    this.models.clear();
    super.dispose();
  }
}
