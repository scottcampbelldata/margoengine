/// <reference lib="esnext.disposable" preserve="true" />
// Interaction and trampling for scatter: a square push field around the camera, one vec2 a cell (the direction grass
// is pushed, its length the amount from 0 to 1). Each frame a compute pass, before the distribute pass, carries the
// field along with the camera in whole cells, lets every cell recover toward upright by exp(-3 dt / recover), and
// stamps each interactor (a player's feet, a vehicle's wheels): within its radius the push points away from its
// centre with amount strength * (1 - (d / radius)^2), and a cell keeps the stronger of its own and the new push. Every
// posing vertex stage (colour and shadow) then turns each instance about its root, away from the push, by up to
// `bend` radians: a rotation, so a vertex keeps its distance from the root and the cull radii still hold.
import type { EngineKernel, Geometry } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { Scatter, type ScatterOptions } from '@margoengine/scatter';
import { rangeError, typeError } from '../../shared/errors.js';
import { compute, dispatch, group } from '../../shared/gpu.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** The push field of {@link TrampledScatter}. */
export interface TrampleOptions {
  /** Side of the square field around the camera, in world units (default 64). Grass outside it is not pushed. */
  size?: number;
  /** Cells along a side, an integer from 8 to 1,024 (default 128). */
  resolution?: number;
  /** Seconds for a push to fall to 5% once nothing presses it (default 1.5). */
  recover?: number;
  /** Largest turn of a fully pressed instance about its root, in radians, above 0 and at most pi / 2 (default 1.2). */
  bend?: number;
}

/** Something that pushes grass: a player's feet, an animal, a vehicle's wheel. */
export interface Interactor {
  /** World centre of the spherical influence; height is measured against the scatter's ground surface. */
  position: readonly [number, number, number];
  /** Radius of the push in world units, above 0. */
  radius: number;
  /** How hard it presses at its centre, 0 to 1 (default 1). */
  strength?: number;
}

/** Interactors at most: one storage element each. */
const MOST = 4096;
/** Words of the field before its cells: origin xz, cells per unit and resolution, bend. */
const HEAD = 3;
// GPU inputs must be finite after conversion; positive divisors must survive WGSL's permitted subnormal flushing.
const gpuFloat = (v: number) => Number.isFinite(v) && Number.isFinite(Math.fround(v));
const gpuPositive = (v: number) => gpuFloat(v) && Math.fround(v) >= 2 ** -126;

/** WGSL of the field read and the turn, for a posing vertex stage: `trample` at `binding` of `group`. */
export function trampleCode(group: number, binding: number): string {
  return `
@group(${group}) @binding(${binding}) var<storage,read> trample:array<vec2f>;
fn trampleCell(c:vec2i,n:i32)->vec2f {if(any(c<vec2i(0))||any(c>=vec2i(n))){return vec2f(0);}return trample[${HEAD}+c.y*n+c.x];}
fn tramplePush(root:vec2f)->vec2f {
 let n=i32(trample[1].y);let t=(root-trample[0])*trample[1].x-0.5;let c=vec2i(floor(t));let f=t-floor(t);
 return mix(mix(trampleCell(c,n),trampleCell(c+vec2i(1,0),n),f.x),mix(trampleCell(c+vec2i(0,1),n),trampleCell(c+vec2i(1,1),n),f.x),f.y);
}
fn trampleTurn(v:vec3f,push:vec2f)->vec3f {
 let amount=length(push);if(amount<=0.0){return v;}
 let a=min(amount,1.0)*trample[2].x;let d=push/amount;let k=vec3f(d.y,0,-d.x);
 return v*cos(a)+cross(k,v)*sin(a)+k*dot(k,v)*(1.0-cos(a));
}
`;
}

const posed = 'var world=scatterTurn(vec3f(p.x*wide,p.y,p.z*wide),c,s,up)*position.w+position.xyz;';
const normal = 'windNormal(scatterTurn(n,c,s,up),bend,wind)';

/**
 * A posing vertex stage `code` with the push turn after the instance's own turn and scale, before the wind: the
 * field `trample` at `binding` of `group`.
 * @throws TypeError when `code` holds no scatter pose to turn.
 */
export function trampledPoseCode(code: string, group: number, binding: number): string {
  const at = code.indexOf('struct ScatterPose ');
  if (at < 0 || code.split(posed).length !== 2 || code.split(normal).length !== 2)
    throw typeError('trampledPoseCode takes a scatter vertex stage', 'scatter');
  return (
    code.slice(0, at) +
    trampleCode(group, binding) +
    code
      .slice(at)
      .replace(posed, posed + 'let push=tramplePush(position.xz);if(dot(push,push)>0.0){world=position.xyz+trampleTurn(world-position.xyz,push);}')
      .replace(normal, 'windNormal(trampleTurn(scatterTurn(n,c,s,up),push),bend,wind)')
  );
}

// Overflow checks precede subtraction. Scale before length to avoid overflow/underflow.
// Shift the same cell, apply recovery, stamp spheres, then clear recovered pushes.
const update = `
struct Update {origin:vec2f,shift:vec2i,cells:f32,n:u32,keep:f32,count:u32,bend:f32,base:f32,bounds:vec4f}
@group(0) @binding(0) var<uniform> u:Update;
@group(0) @binding(1) var<storage,read> field:array<vec2f>;
@group(0) @binding(2) var<storage,read_write> next:array<vec2f>;
@group(0) @binding(3) var<storage,read> movers:array<vec4f>;
@group(0) @binding(4) var ground:texture_2d<f32>;
fn groundHeight(p:vec2i)->f32 {return textureLoad(ground,clamp(p,vec2i(0),vec2i(textureDimensions(ground))-1),0).r;}
fn groundAt(w:vec2f)->f32 {
 let t=(w-u.bounds.xy)/(u.bounds.zw-u.bounds.xy)*vec2f(textureDimensions(ground))-0.5;
 let c=vec2i(floor(t));let f=t-floor(t);
 return mix(mix(groundHeight(c),groundHeight(c+vec2i(1,0)),f.x),mix(groundHeight(c+vec2i(0,1)),groundHeight(c+vec2i(1,1)),f.x),f.y)+u.base;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u){
 let n=u.n;if(g.x>=n||g.y>=n){return;}
 if(g.x==0u&&g.y==0u){next[0]=u.origin;next[1]=vec2f(u.cells,f32(n));next[2]=vec2f(u.bend,0);}
 let old=vec2i(g.xy)+u.shift;var v=vec2f(0);
 if(all(old>=vec2i(0))&&all(old<vec2i(i32(n)))){v=field[${HEAD}u+u32(old.y)*n+u32(old.x)]*u.keep;}
 let w=u.origin+(vec2f(g.xy)+0.5)/u.cells;
 let surface=vec3f(w.x,groundAt(w),w.y);
 for(var i=0u;i<u.count;i++){
  let m=movers[i*2u];let strength=movers[i*2u+1u].x;
  let bound=vec3f(3.4028234663852886e38)-abs(m.xyz);
  if(((surface.x<0)!=(m.x<0)&&abs(surface.x)>=bound.x)||((surface.y<0)!=(m.y<0)&&abs(surface.y)>=bound.y)||((surface.z<0)!=(m.z<0)&&abs(surface.z)>=bound.z)){continue;}
  let o=surface-m.xyz;let a=max(max(abs(o.x),abs(o.y)),abs(o.z));
  if(a<m.w&&a>0){
   let axis=o/a;let norm=length(axis);let d=(a/m.w)*norm;
   let horizontal=max(abs(o.x),abs(o.z));
   if(d<1.0&&horizontal>0){let direction=o.xz/horizontal;let length2=length(direction);
    if(horizontal>1e-6/length2){let s=strength*(1.0-d*d);if(s>length(v)){v=direction/length2*s;}}
   }
  }
 }
 if(length(v)<1e-3){v=vec2f(0);}
 next[${HEAD}u+g.y*n+g.x]=v;
}`;

/**
 * A {@link Scatter} whose instances bend away from players and vehicles and spring back: pass the interactors each
 * frame with {@link TrampledScatter.setInteractors}. The push field covers a square around the camera
 * (`trample.size`), moves with it in whole cells, and every instance turns about its root away from the push, in the
 * colour and the shadow passes alike. `TrampledScatter.attach(engine, geometry, options, trample)`.
 * @throws RangeError when a trample option or an interactor is out of range; TypeError when an interactor is not an
 * object with a position and a radius.
 */
export class TrampledScatter extends Scatter {
  readonly #size: number;
  readonly #n: number;
  readonly #recover: number;
  readonly #bend: number;
  #movers = new Float32Array(8);
  #count = 0;
  #delta = 0;
  #origin?: [number, number];
  #field?: GPUBuffer;
  #next?: GPUBuffer;
  #moverBuffer?: GPUBuffer;
  #uniform?: GPUBuffer;
  #kernel?: GPUComputePipeline;
  #group?: GPUBindGroup;
  #ground?: GPUTexture;
  readonly #words = new ArrayBuffer(64);

  constructor(
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ScatterOptions = {},
    trample: TrampleOptions = {},
  ) {
    super(geometry, options);
    if (!trample || typeof trample !== 'object') throw typeError('Trample options must be an object', 'scatter');
    const { size = 64, resolution = 128, recover = 1.5, bend = 1.2 } = trample;
    if (!(Number.isInteger(resolution) && resolution >= 8 && resolution <= 1024))
      throw rangeError('A trample resolution is an integer from 8 to 1024', 'scatter');
    if (!(gpuPositive(size) && gpuPositive(resolution / size)))
      throw rangeError('A trample size and its cells per unit must fit positive normal GPU floats', 'scatter');
    if (!(Number.isFinite(recover) && recover > 0)) throw rangeError('A trample recover time is seconds above 0', 'scatter');
    if (!(gpuPositive(bend) && bend <= Math.PI / 2))
      throw rangeError('A trample bend must fit a positive normal GPU float, at most pi / 2 radians', 'scatter');
    this.#size = size;
    this.#n = resolution;
    this.#recover = recover;
    this.#bend = bend;
  }

  static override attach(
    engine: EngineKernel,
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ScatterOptions = {},
    trample: TrampleOptions = {},
  ): TrampledScatter {
    const effect = new TrampledScatter(geometry, options, trample);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /**
   * The interactors pressing the grass this frame (replacing the last call's); pass an empty list when nothing
   * presses. Grass they leave recovers over `trample.recover` seconds.
   */
  setInteractors(interactors: readonly Interactor[]): this {
    if (!Array.isArray(interactors) || interactors.length > MOST)
      throw rangeError('setInteractors takes an array of at most 4096 interactors', 'scatter');
    // Validate the entire list before changing the retained upload, including holes that forEach/every would skip.
    for (let i = 0; i < interactors.length; i++) {
      const m = interactors[i];
      if (!m || typeof m !== 'object' || !Array.isArray(m.position) || m.position.length !== 3)
        throw typeError('An interactor is { position: [x, y, z], radius, strength? }', 'scatter');
      const { position: p, radius, strength = 1 } = m;
      if (![p[0], p[1], p[2]].every(gpuFloat))
        throw rangeError('An interactor position is three finite GPU float numbers', 'scatter');
      if (!gpuPositive(radius)) throw rangeError('An interactor radius must fit a positive normal GPU float', 'scatter');
      if (!(Number.isFinite(strength) && strength >= 0 && strength <= 1))
        throw rangeError('An interactor strength is a number from 0 to 1', 'scatter');
    }
    if (this.#movers.length < interactors.length * 8)
      this.#movers = new Float32Array(Math.max(4, 2 ** Math.ceil(Math.log2(interactors.length))) * 8);
    interactors.forEach(({ position: p, radius, strength = 1 }, i) => {
      this.#movers.set([p[0], p[1], p[2], radius, strength, 0, 0, 0], i * 8);
    });
    this.#count = interactors.length;
    return this;
  }

  /** The push field on the GPU: origin, scale and bend, then one vec2 a cell; undefined before the first frame. */
  get field(): GPUBuffer | undefined {
    return this.#field;
  }

  override onPreUpdate(delta: number): void {
    super.onPreUpdate(delta);
    this.#delta += delta;
  }

  protected override poseCode(code: string, group: number, binding: number): string {
    return trampledPoseCode(super.poseCode(code, group, binding), group, binding + super.poseEntries().length);
  }

  protected override poseEntries(): { buffer: GPUBuffer }[] {
    return [...super.poseEntries(), { buffer: this.#fieldBuffer() }];
  }

  protected override beforeDistribute(c: Context, terrain: GPUTexture): void {
    super.beforeDistribute(c, terrain);
    const d = c.device,
      n = this.#n,
      cells = n / this.#size,
      field = this.#fieldBuffer(),
      // The field's corner cell, the camera's cell less half the field: it moves in whole cells.
      origin: [number, number] = [
        Math.floor(c.camera.position[0] * cells) - (n >> 1),
        Math.floor(c.camera.position[2] * cells) - (n >> 1),
      ],
      last = this.#origin ?? origin,
      floats = new Float32Array(this.#words),
      words = new Int32Array(this.#words);
    this.#origin = origin;
    floats.set([origin[0] / cells, origin[1] / cells]);
    // Once a shift reaches the field's side there is no overlap. Clamp before Int32 conversion, which would wrap.
    words.set(origin.map((v, i) => Math.max(-n, Math.min(n, v - last[i]))), 2);
    floats[4] = cells;
    words[5] = n;
    floats[6] = Math.exp((-3 * this.#delta) / this.#recover);
    words[7] = this.#count;
    floats[8] = this.#bend;
    floats[9] = this.values[30];
    floats.set(this.options.bounds ?? [
      this.values[22] - this.values[20] / 2, this.values[23] - this.values[21] / 2,
      this.values[22] + this.values[20] / 2, this.values[23] + this.values[21] / 2,
    ], 12);
    this.#delta = 0;
    if (!this.#moverBuffer || this.#moverBuffer.size < this.#movers.byteLength) {
      this.#moverBuffer?.destroy();
      this.#moverBuffer = d.createBuffer({
        size: this.#movers.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#group = undefined;
    }
    d.queue.writeBuffer(this.#moverBuffer, 0, this.#movers as Float32Array<ArrayBuffer>, 0, Math.max(8, this.#count * 8));
    this.#uniform ??= d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.#uniform, 0, this.#words);
    this.#kernel ??= compute(d, update);
    if (this.#ground !== terrain) {
      this.#ground = terrain;
      this.#group = undefined;
    }
    this.#group ??= group(d, this.#kernel, [
      { buffer: this.#uniform },
      { buffer: field },
      { buffer: this.#next! },
      { buffer: this.#moverBuffer },
      terrain.createView(),
    ]);
    dispatch(c, this.#kernel, this.#group, Math.ceil(n / 8), Math.ceil(n / 8));
    c.encoder.copyBufferToBuffer(this.#next!, 0, field, 0, field.size);
  }

  /** The field and its scratch copy, made on first use. */
  #fieldBuffer(): GPUBuffer {
    if (!this.#field) {
      const d = this.engine!.gpu!,
        size = (HEAD + this.#n * this.#n) * 8;
      this.#field = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      this.#next = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      // Before the first update: an empty field at the origin.
      d.queue.writeBuffer(this.#field, 0, new Float32Array([0, 0, this.#n / this.#size, this.#n, this.#bend, 0]));
    }
    return this.#field;
  }

  protected override release(): void {
    super.release();
    for (const b of [this.#field, this.#next, this.#moverBuffer, this.#uniform]) b?.destroy();
    this.#field = this.#next = this.#moverBuffer = this.#uniform = undefined;
    this.#kernel = this.#group = this.#origin = undefined;
    this.#ground = undefined;
  }
}
