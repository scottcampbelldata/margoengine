import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { orthographic } from '../../shared/projection.js';
import { SceneTargets } from './mrt.js';
import type { SSRModel } from './ssr.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';

/** Screen-space ridge and valley shading from signed normal gradients. */
export interface CurvatureOptions {
  /** Convex ridge highlight strength, 0..100. Default 1. */
  ridge?: number;
  /** Concave valley darkening strength, 0..100. Default 1. */
  valley?: number;
  /** Sample radius in whole drawing pixels, 1..16. Default 2. */
  radius?: number;
  /** Ignore gradient magnitudes below this, 0..1. Default 0. */
  threshold?: number;
  /** Reject neighbours beyond this relative linear-depth step, positive up to 1. Default 0.02. */
  depthThreshold?: number;
  /** Optional signed xyz normals, any size; undefined texture passes through. Default owned SceneTargets capture. */
  normal?: () => GPUTexture | undefined;
  /** Coordinate system of supplied normals. Default world; owned normals are always world-space. */
  normalSpace?: 'world' | 'view';
  /** Default true. */
  enabled?: boolean;
}
const shader = `${fullscreen}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var normals:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var<uniform> u:array<vec4f,4>;
fn away(p:vec2i)->f32{let d=textureLoad(depth,p,0);return abs((u[3].x+u[3].y*d)/(u[3].z+u[3].w*d));}
fn normal(p:vec2i)->vec3f{let q=clamp(vec2i((vec2f(p)+0.5)/vec2f(textureDimensions(scene))*vec2f(textureDimensions(normals))),vec2i(0),vec2i(textureDimensions(normals))-1);let n=textureLoad(normals,q,0).xyz;return n/max(length(n),1e-6);}
fn neighbour(p:vec2i,z:f32,n:vec3f)->vec3f{let q=clamp(p,vec2i(0),vec2i(textureDimensions(scene))-1);let m=normal(q);if(textureLoad(depth,q,0)<=0.0||dot(m,m)<0.5||abs(away(q)-z)>u[2].w*max(z,1e-6)){return n;}return m;}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let q=vec2i(p.xy);let s=textureLoad(scene,q,0);let n=normal(q);
 if(u[1].w==0.0||dot(n,n)<0.5||textureLoad(depth,q,0)<=0.0){return s;}
 let z=away(q);let r=i32(u[0].z);
 let nx=neighbour(q+vec2i(r,0),z,n)-neighbour(q-vec2i(r,0),z,n);
 let ny=neighbour(q+vec2i(0,r),z,n)-neighbour(q-vec2i(0,r),z,n);
 let k=(dot(nx,u[1].xyz)-dot(ny,u[2].xyz))/(2.0*u[0].z);
 let ridge=clamp(max(k-u[0].w,0.0)*u[0].x*8.0,0.0,1.0);
 let valley=clamp(max(-k-u[0].w,0.0)*u[0].y*8.0,0.0,1.0);
 return vec4f(mix(s.rgb*(1.0-valley),vec3f(s.a),ridge),s.a);
}`;

/** View-dependent ridge/valley enhancement with depth rejection, using captured or supplied shading normals. */
export class Curvature extends ScreenEffect {
  readonly name = 'curvature';
  protected readonly kind = 'ldr';
  private readonly targets = new SceneTargets({ outputs: { normal: 'normal' } });
  private readonly values = new Float32Array(16);
  private blank?: GPUTexture;
  constructor(readonly options: CurvatureOptions = {}) {
    super();
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: CurvatureOptions = {}): Curvature {
    const e = new Curvature(options);
    e.stack = PostStack.attach(engine, [e]);
    return e;
  }
  /** Include an optional model's own shading normals, deformation and alpha masks in the default capture. */
  add(model: SSRModel): () => void {
    return this.targets.add(model);
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.capture(engine);
  }
  /** A provider removed after setup falls back to the owned capture before the next frame's graph runs. */
  onPreUpdate(): void {
    if (this.engine) this.capture(this.engine);
  }
  private capture(engine: Engine): void {
    if (!this.options.normal && !engine.sceneOf(this.targets)) engine.use(this.targets);
  }
  protected check(): void {
    const o = this.options;
    for (const key of ['ridge', 'valley'] as const)
      if (o[key] !== undefined && !(Number.isFinite(o[key]) && o[key]! >= 0 && o[key]! <= 100))
        throw new RangeError(`Use Curvature ${key} from 0 to 100`);
    if (!Number.isInteger(o.radius ?? 2) || (o.radius ?? 2) < 1 || (o.radius ?? 2) > 16)
      throw new RangeError('Use Curvature radius as an integer from 1 to 16');
    if (
      !(Number.isFinite(o.threshold ?? 0) && (o.threshold ?? 0) >= 0 && (o.threshold ?? 0) <= 1) ||
      !(Number.isFinite(o.depthThreshold ?? 0.02) && (o.depthThreshold ?? 0.02) > 0 && (o.depthThreshold ?? 0.02) <= 1)
    )
      throw new RangeError('Use Curvature threshold in 0..1 and positive depthThreshold up to 1');
    if (o.normal !== undefined && typeof o.normal !== 'function')
      throw new TypeError('Use Curvature normal as () => texture');
    if (o.normalSpace !== undefined && !['world', 'view'].includes(o.normalSpace))
      throw new RangeError('Use Curvature normalSpace world or view');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Use Curvature enabled as true or false');
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      v = this.values,
      normal = o.normal ? o.normal() : this.targets.texture('normal');
    v.set([
      o.ridge ?? 1,
      o.valley ?? 1,
      o.radius ?? 2,
      o.threshold ?? 0,
      1,
      0,
      0,
      +(o.enabled !== false),
      0,
      1,
      0,
      o.depthThreshold ?? 0.02,
    ]);
    if (!o.normal || o.normalSpace !== 'view') {
      const p = c.camera.position,
        t = c.camera.target,
        up = c.camera.up ?? [0, 1, 0];
      let zx = p[0] - t[0],
        zy = p[1] - t[1],
        zz = p[2] - t[2];
      const len = Math.hypot(zx, zy, zz);
      zx /= len;
      zy /= len;
      zz /= len;
      let x = up[1] * zz - up[2] * zy,
        y = up[2] * zx - up[0] * zz,
        z = up[0] * zy - up[1] * zx;
      const r = Math.hypot(x, y, z);
      x /= r;
      y /= r;
      z /= r;
      v.set([x, y, z], 4);
      v.set([zy * z - zz * y, zz * x - zx * z, zx * y - zy * x], 8);
    }
    const eye = orthographic(c.camera.matrix, c.camera.position);
    v.set(
      eye
        ? [eye.far, eye.near - eye.far, 1, 0]
        : [c.camera.near * c.camera.far, 0, c.camera.near, c.camera.far - c.camera.near],
      12,
    );
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    this.blank ??= c.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x4 | 0x10 });
    this.draw(c, shader, output, [
      input,
      (normal ?? this.blank).createView(),
      this.host!.depthTexture!.createView({ aspect: 'depth-only' }),
      { buffer: this.uniform! },
    ]);
  }
  protected override release(): void {
    super.release();
    this.blank?.destroy();
    this.blank = undefined;
  }
  override dispose(): void {
    super.dispose();
    this.targets.dispose();
  }
}
