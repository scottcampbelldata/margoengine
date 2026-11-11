import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { orthographic } from '../../shared/projection.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { SceneTargets } from './mrt.js';
import type { SSRModel } from './ssr.js';
import { PostStack } from './stack.js';

/** Pixel-art sampling and independent geometric edge controls. Values are read each frame. */
export interface PixelateOptions {
  /** Whole drawing-buffer pixels per square cell, 1..128. Default 6. */
  pixelSize?: number;
  /** Silhouette darkening, 0..1. Default 0.4. */
  depthEdgeStrength?: number;
  /** Crease highlighting, 0..1. Default 0.3. */
  normalEdgeStrength?: number;
  /** Relative linear-depth step that begins a silhouette, positive. Default 0.02. */
  depthThreshold?: number;
  /** 1 - dot(n0,n1) that begins a crease, positive. Default 0.1. */
  normalThreshold?: number;
  /** Optional signed xyz unit normal texture, any size. Default an owned scene-normal capture. */
  normal?: () => GPUTexture | undefined;
  /** Default true. */
  enabled?: boolean;
}
const shader = (normal: boolean) => `${fullscreen}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var<uniform> u:array<vec4f,3>;
${normal ? '@group(0) @binding(3) var normals:texture_2d<f32>;' : ''}
fn away(p:vec2i)->f32{let d=textureLoad(depth,p,0);return abs((u[2].x+u[2].y*d)/(u[2].z+u[2].w*d));}
${normal ? 'fn norm(p:vec2i)->vec3f{let q=clamp(vec2i((vec2f(p)+0.5)/vec2f(textureDimensions(scene))*vec2f(textureDimensions(normals))),vec2i(0),vec2i(textureDimensions(normals))-1);let n=textureLoad(normals,q,0).xyz;return n/max(length(n),1e-6);}' : ''}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let top=vec2i(textureDimensions(scene))-1;let cell=i32(u[0].x);
 let q=min((vec2i(p.xy)/cell)*cell+vec2i(cell/2),top);let s=textureLoad(scene,q,0);
 var de=0.0;var ne=0.0;
 if(textureLoad(depth,q,0)>0.0){
  let z=away(q);${normal ? 'let n=norm(q);' : ''}
  let offsets=array<vec2i,4>(vec2i(-1,0),vec2i(1,0),vec2i(0,-1),vec2i(0,1));
  for(var i=0;i<4;i++){
   let r=clamp(q+offsets[i]*cell,vec2i(0),top);let dz=(away(r)-z)/max(z,1e-6);
   de=max(de,smoothstep(u[1].x,u[1].x*2.0,dz));
   ${normal ? 'let m=norm(r);if(dot(m,m)>0.5&&dot(n,n)>0.5&&abs(dz)<u[1].x){ne=max(ne,smoothstep(u[1].y,u[1].y*2.0,1.0-dot(n,m)));}' : ''}
  }
 }
 let lit=mix(s.rgb,vec3f(s.a),ne*u[0].z);return vec4f(lit*(1.0-de*u[0].y),s.a);
}`;

/** Pixel-art downsample with depth silhouettes and captured or supplied normal highlights. An LDR stack stage. */
export class Pixelate extends ScreenEffect {
  readonly name = 'pixelate';
  protected readonly kind = 'ldr';
  private readonly targets = new SceneTargets({ outputs: { normal: 'normal' } });
  private readonly values = new Float32Array(12);
  constructor(readonly options: PixelateOptions = {}) {
    super();
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: PixelateOptions = {}): Pixelate {
    const effect = new Pixelate(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Include an optional model's materials, alpha masks and deformed normals in the owned capture. */
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
    const o = this.options,
      p = o.pixelSize ?? 6;
    if (!Number.isInteger(p) || p < 1 || p > 128)
      throw new RangeError('Use Pixelate pixelSize as an integer from 1 to 128');
    for (const key of ['depthEdgeStrength', 'normalEdgeStrength'] as const)
      if (o[key] !== undefined && !(Number.isFinite(o[key]) && o[key]! >= 0 && o[key]! <= 1))
        throw new RangeError(`Use Pixelate ${key} from 0 to 1`);
    for (const key of ['depthThreshold', 'normalThreshold'] as const)
      if (o[key] !== undefined && !(Number.isFinite(o[key]) && o[key]! > 0))
        throw new RangeError(`Use a positive finite Pixelate ${key}`);
    if (o.normal !== undefined && typeof o.normal !== 'function')
      throw new TypeError('Use Pixelate normal as () => texture');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Use Pixelate enabled as true or false');
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      live = o.enabled !== false,
      eye = orthographic(c.camera.matrix, c.camera.position);
    this.values.set([
      live ? (o.pixelSize ?? 6) : 1,
      live ? (o.depthEdgeStrength ?? 0.4) : 0,
      live ? (o.normalEdgeStrength ?? 0.3) : 0,
      0,
      o.depthThreshold ?? 0.02,
      o.normalThreshold ?? 0.1,
      0,
      0,
    ]);
    this.values.set(
      eye
        ? [eye.far, eye.near - eye.far, 1, 0]
        : [c.camera.near * c.camera.far, 0, c.camera.near, c.camera.far - c.camera.near],
      8,
    );
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    const normal = o.normal ? o.normal() : this.targets.texture('normal');
    const resources: GPUBindingResource[] = [
      input,
      this.host!.depthTexture!.createView({ aspect: 'depth-only' }),
      { buffer: this.uniform! },
    ];
    if (normal) resources.push(normal.createView());
    this.draw(c, shader(!!normal), output, resources);
  }
  override dispose(): void {
    super.dispose();
    this.targets.dispose();
  }
}
