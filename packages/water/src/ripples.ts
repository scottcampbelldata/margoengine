/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import type { Water } from './index.js';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { fault } from '../../shared/errors.js';
import { WATER_FLOW_TICKS_PER_FRAME } from './film.js';
import {
  cloneObstacle,
  displacedHeight,
  finite,
  RIPPLE_DISPLACED,
  insideObstacle,
  MAX_RIPPLE_OBSTACLES,
  packObstacleList,
  rippleError,
  RippleField,
  type RippleObstacle,
  type RippleSample,
  type RippleSnapshot,
} from './ripple-field.js';
export {
  MAX_RIPPLE_OBSTACLES,
  RippleField,
  type RippleBoxObstacle,
  type RippleCylinderObstacle,
  type RippleFieldOptions,
  type RippleObstacle,
  type RippleSample,
  type RippleSnapshot,
  type RippleSphereObstacle,
  type RippleStep,
  type RippleWallObstacle,
} from './ripple-field.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** World position accepted by {@link Ripples.trackBody}: array-like [x, y, z] or `{ x, y, z }`. */
export type RipplePosition =
  | readonly [number, number, number]
  | ArrayLike<number>
  | { readonly x: number; readonly y: number; readonly z: number };

/** Any moving object with a world `position` (physics rigid body, Floater, core mesh, or custom object). */
export interface RippleTrackedBody {
  readonly position: RipplePosition;
}
/** Per-body coupling settings for {@link Ripples.trackBody}. */
export interface RippleTrackOptions {
  /** Disturbance radius in metres (at least one ripple cell). Default max(1, cell). */
  radius?: number;
  /** Wake and splash amplitude scale in signed metres, -100..100. Default 0.08. */
  strength?: number;
  /** Vertical half-height around `position.y` that counts as intersecting the surface, > 0. Default radius. */
  halfHeight?: number;
  /** Multiplier applied to entry and exit splashes, 0..10. Default 2.5. */
  splashStrength?: number;
  /** Minimum horizontal displacement in metres per update to emit a wake, 0..100. Default 0.02. */
  minSpeed?: number;
  /** Reflect ripples off this body as a moving solid obstacle while it intersects the surface. Default false (true with `volume`). */
  obstacle?: boolean;
  /**
   * The body's volume under the water now, m^3 (`() => loads.bodyLoad(i).submerged`). With it the body makes ripples
   * by the water it pushes aside: each update a ring from `radius` out to twice that takes back the volume it held where
   * it was and gives the volume it holds now where it is, so the field's water grows by exactly the change in the
   * body's displacement (a body sinking in raises a ring, one moving along pushes a bow wave and leaves a trough) and the
   * speed-rated splash and wake are off. Give `radius` the body's waterline half width. The body is then also an
   * `obstacle` by default, so the ring it makes reflects off it instead of focusing back under it. Default none.
   */
  volume?: () => number;
}
/** Debug visualization channel for {@link Ripples.setDebug}. */
export type RippleDebugMode = 'height' | 'velocity' | 'obstacles';
/** Debug visualization settings for {@link Ripples.setDebug}. */
export interface RippleDebugOptions {
  /** Enable or disable the debug overlay on the water surface. Default true when passing an options object. */
  enabled?: boolean;
  /** Field channel to show: 'height', 'velocity', or 'obstacles'. Default 'height'. */
  mode?: RippleDebugMode;
  /** Highlight the active scroll-grid border and 8-cell absorbing sponge margin. Default true. */
  bounds?: boolean;
}

/** Camera-centred local wave simulation. Construction settings are copied. Distances are metres. */
export interface RippleOptions {
  /** Water attached to the same engine. */
  surface: Water;
  /** Square field width, 1..10000. Default 64. */
  size?: number;
  /** Grid side, integer 16..512. Default 128. */
  resolution?: number;
  /** Propagation speed, 0.01..100 m/s. Default 3. */
  speed?: number;
  /** Velocity decay per second, 0..100. Default 0.6. */
  damping?: number;
  /** Centre on camera XZ in whole cells. Default true. False centres at [0,0]. */
  followCamera?: boolean;
  /** Optional initial solid obstacles that reflect ripples. */
  obstacles?: readonly RippleObstacle[];
  /**
   * Step a CPU copy of the field beside the GPU's, with the shader's arithmetic, so `sample`, `snapshot` and
   * `stateHash` answer in the frame they are asked (floating bodies ride the ripples) and `restore` can set both.
   * Costs one CPU pass over the grid a substep. Default false.
   */
  cpu?: boolean;
}
/** The surface a `Ripples` draws at a point: its Water's surface plus the ripples on it. */
export interface RippleSurfaceSample {
  /** World Y of the surface, m. */
  height: number;
  /** Unit normal, pointing up. */
  normal: [number, number, number];
  /** Velocity of the surface water, m/s: the Water's orbital motion plus the ripples' vertical speed. */
  velocity: [number, number, number];
}
/** Last submitted GPU height/vertical-velocity field, row-major, two floats per cell. */
export interface RippleFrame {
  /** Lower left world XZ of the grid's outer edge. */
  readonly origin: readonly [number, number];
  /** Grid side. */
  readonly resolution: number;
  /** Cell width in metres. */
  readonly cellSize: number;
  /** Height and vertical velocity pairs. */
  readonly data: Float32Array;
}

interface TrackedState {
  radius: number;
  strength: number;
  halfHeight: number;
  splashStrength: number;
  minSpeed: number;
  obstacle: boolean;
  initialized: boolean;
  prevX: number;
  prevY: number;
  prevZ: number;
  wasInWater: boolean;
  volume: (() => number) | undefined;
  prevVolume: number;
}

const DEBUG_MODE_INDEX: Record<RippleDebugMode, number> = { height: 0, velocity: 1, obstacles: 2 };

const compute = `
struct Params { grid:vec4f, step:vec4f, shift:vec4i, solids:vec4u, hits:array<vec4f,128>, obstacles:array<vec4f,64> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> source:array<vec2f>;
@group(0) @binding(2) var<storage,read_write> outputField:array<vec2f>;
fn at(p:vec2i)->vec2f {
 if(any(p<vec2i(0))||any(p>=vec2i(i32(u.grid.w)))){return vec2f(0);}
 return source[u32(p.y)*u32(u.grid.w)+u32(p.x)];
}
// Packed obstacles, two vec4 each: kind 1 a disc (centre, radius), 2 a box (centre, half sizes, yaw cosine and sine),
// 3 a wall segment (its two ends, half thickness).
fn isObstacle(world:vec2f)->bool {
 for(var i=0u;i<u.solids.x;i++){
  let o0=u.obstacles[i*2u];let o1=u.obstacles[i*2u+1u];
  if(o1.z<1.5){
   let d=world-o0.xy;if(dot(d,d)<=o0.z*o0.z){return true;}
  }else if(o1.z<2.5){
   let d=world-o0.xy;let lx=d.x*o1.x+d.y*o1.y;let lz=-d.x*o1.y+d.y*o1.x;
   if(abs(lx)<=o0.z&&abs(lz)<=o0.w){return true;}
  }else{
   let seg=o0.zw-o0.xy;let t=clamp(dot(world-o0.xy,seg)/max(dot(seg,seg),0.000001),0.0,1.0);
   let diff=world-o0.xy-t*seg;if(dot(diff,diff)<=o1.x*o1.x){return true;}
  }
 }
 return false;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 let n=u32(u.grid.w);if(id.x>=n||id.y>=n){return;}
 let p=vec2i(id.xy);let old=p+u.shift.xy;let c=u.grid.z;
 let world=u.grid.xy+(vec2f(id.xy)+0.5)*c;
 // Solid cells stay at rest.
 if(u.solids.x>0u&&isObstacle(world)){outputField[id.y*n+id.x]=vec2f(0.0,0.0);return;}
 let v=at(old);
 var hE=at(old+vec2i(1,0)).x;var hW=at(old-vec2i(1,0)).x;
 var hN=at(old+vec2i(0,1)).x;var hS=at(old-vec2i(0,1)).x;
 // A solid neighbour reads this cell's own height: a mirrored face, the homogeneous Neumann wall dh/dn = 0.
 if(u.solids.x>0u){
  if(isObstacle(world+vec2f(c,0.0))){hE=v.x;}
  if(isObstacle(world-vec2f(c,0.0))){hW=v.x;}
  if(isObstacle(world+vec2f(0.0,c))){hN=v.x;}
  if(isObstacle(world-vec2f(0.0,c))){hS=v.x;}
 }
 let lap=hE+hW+hN+hS-4.0*v.x;
 // The outer 8 cells damp at up to 12 /s more (a sponge layer), so waves leave the grid instead of reflecting.
 let edge=f32(min(min(id.x,id.y),min(n-1u-id.x,n-1u-id.y)));
 let decay=exp(-(u.step.z+12.0*(1.0-smoothstep(0.0,8.0,edge)))*u.step.x);
 let velocity=(v.y+lap*u.step.y*u.step.x/(c*c))*decay;
 var h=v.x+velocity*u.step.x;
 // Drops and swept wakes born this step: the zero-mean profile (1-q)^2 (1-4q) around each event's segment; a body's
 // displaced water (kind b.z = 1) is a ring from b.w out to b.x, its height (1-s^2)^2 across it, none under the body.
 for(var i=0u;i<u32(u.step.w);i++){
  let a=u.hits[i*2u];let b=u.hits[i*2u+1u];let d=a.zw-a.xy;
  let t=clamp(dot(world-a.xy,d)/max(dot(d,d),0.000001),0.0,1.0);
  let q=dot(world-a.xy-t*d,world-a.xy-t*d)/(b.x*b.x);
  if(b.z>0.5){
   let w=(b.x-b.w)*0.5;let s=(sqrt(q)*b.x-(b.x+b.w)*0.5)/w;
   if(s*s<1.0){h+=b.y*(1.0-s*s)*(1.0-s*s);}
  }else if(q<1.0){h+=b.y*(1.0-q)*(1.0-q)*(1.0-4.0*q);}
 }
 outputField[id.y*n+id.x]=vec2f(h,velocity);
}`;

let sequence = 0;
/** A tracked body's submerged volume now, m^3, checked. */
function submerged(volume: () => number): number {
  const v = volume();
  if (!(Number.isFinite(v) && v >= 0))
    throw rippleError("Invalid tracked volume; the volume function must return the body's finite submerged m^3");
  return v;
}
function readXYZ(pos: RipplePosition): [number, number, number] | null {
  if (!pos || typeof pos !== 'object') return null;
  if ('x' in pos && 'y' in pos && 'z' in pos) {
    const { x, y, z } = pos;
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
  }
  const arr = pos as ArrayLike<number>;
  if (typeof arr.length === 'number' && arr.length >= 3) {
    const x = arr[0]!,
      y = arr[1]!,
      z = arr[2]!;
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
  }
  return null;
}

/** GPU wave equation with drops, swept object wakes, solid obstacle reflections, body coupling, world-preserving scrolling and debug view. */
export class Ripples implements EnginePlugin {
  readonly name = `water:ripples-${sequence++}`;
  private readonly surface: Water;
  private readonly size: number;
  private readonly resolution: number;
  private readonly speed: number;
  private readonly damping: number;
  private readonly follow: boolean;
  private readonly pending: number[] = [];
  /** The clock tick each queued event falls due on (-1 without a film clock: the next step). */
  private readonly due: number[] = [];
  // 16 header floats + 512 hit floats + 256 obstacle floats = 784 floats (3,136 bytes).
  private readonly parameters = new Float32Array(784);
  // Surface uniform: grid (4) + debug (4) + obstacles (256) = 264 floats (1,056 bytes).
  private readonly surfaceUniformData = new Float32Array(264);
  private readonly packedObstacles = new Float32Array(MAX_RIPPLE_OBSTACLES * 8);
  private packedObstacleCount = 0;
  private obstacleList: RippleObstacle[] = [];
  private readonly tracked = new Map<RippleTrackedBody, TrackedState>();
  private debugState: Required<RippleDebugOptions> = { enabled: false, mode: 'height', bounds: true };
  private readonly origin: [number, number] = [0, 0];
  private engine?: Engine;
  private buffers: GPUBuffer[] = [];
  private fields: GPUBuffer[] = [];
  private uniform?: GPUBuffer;
  private configs: GPUBuffer[] = [];
  private resources: GPUBindingResource[] = [];
  private pipeline?: GPUComputePipeline;
  private groups: GPUBindGroup[][] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private delta = 0;
  /** Ticks stepped since the field started, when the surface has a film clock. */
  private done = 0;
  private dirty = true;
  private surfaceDirty = true;
  private rendered = false;
  private disposed = false;
  private generation = 0;
  private reading = false;
  /** The CPU copy of the field (`cpu: true`), stepped with every GPU step. */
  private readonly mirror?: RippleField;

  constructor(options: RippleOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Ripples need a Water surface; pass options.surface');
    this.surface = options.surface;
    this.size = finite(options.size ?? 64, 1, 10000, 'size');
    this.resolution = finite(options.resolution ?? 128, 16, 512, 'resolution');
    if (!Number.isInteger(this.resolution)) throw rippleError('Ripple resolution must be an integer; use 16..512');
    this.speed = finite(options.speed ?? 3, 0.01, 100, 'speed');
    this.damping = finite(options.damping ?? 0.6, 0, 100, 'damping');
    this.follow = options.followCamera ?? true;
    if (typeof this.follow !== 'boolean') throw rippleError('Invalid followCamera; pass a boolean');
    // A quarter-second stall must remain bounded in both work and numerical stability.
    if (Math.ceil((0.25 * this.speed) / (0.45 * this.cell)) > 512)
      throw rippleError('Ripple grid needs too many stable substeps; increase size or reduce resolution or speed');
    this.origin[0] = this.origin[1] = -this.size / 2;
    if (options.obstacles !== undefined) this.setObstacles(options.obstacles);
    const cpu = options.cpu ?? false;
    if (typeof cpu !== 'boolean') throw rippleError('Invalid ripple cpu; pass true or false');
    if (cpu)
      this.mirror = new RippleField({
        size: this.size,
        resolution: this.resolution,
        speed: this.speed,
        damping: this.damping,
      });
  }
  /** Attach after the Water surface. */
  static attach(engine: EngineKernel, options: RippleOptions): Ripples {
    const effect = new Ripples(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  private get cell(): number {
    return this.size / this.resolution;
  }
  /** Active static solid obstacles. A frozen copy. */
  get obstacles(): readonly RippleObstacle[] {
    return Object.freeze([...this.obstacleList]);
  }
  /** Number of moving bodies currently tracked by {@link trackBody}. */
  get trackedCount(): number {
    return this.tracked.size;
  }
  /** Current debug visualization settings. A copy. */
  get debug(): Readonly<Required<RippleDebugOptions>> {
    return Object.freeze({ ...this.debugState });
  }
  /**
   * Set solid obstacles (spheres, cylinders, oriented boxes, and walls; up to 32) that mask cells and reflect
   * incoming ripples cleanly using homogeneous Neumann boundary conditions. Replaces any previous static obstacles.
   */
  setObstacles(obstacles: readonly RippleObstacle[]): this {
    this.live();
    if (!Array.isArray(obstacles)) throw rippleError('Invalid ripple obstacles; pass an array of obstacle descriptors');
    if (obstacles.length > MAX_RIPPLE_OBSTACLES)
      throw rippleError(`Too many ripple obstacles; pass at most ${MAX_RIPPLE_OBSTACLES} obstacles`);
    const validated = obstacles.map((obs) => cloneObstacle(obs));
    this.obstacleList = validated;
    this.dirty = true;
    this.surfaceDirty = true;
    return this;
  }
  /**
   * Synchronously test whether world `(x, z)` lies inside an active solid obstacle at the current water level.
   */
  isObstacle(x: number, z: number): boolean {
    this.live();
    finite(x, -1e7, 1e7, 'position');
    finite(z, -1e7, 1e7, 'position');
    this.packObstacles();
    return insideObstacle(this.packedObstacles, this.packedObstacleCount, x, z);
  }
  /**
   * Track any moving object with `{ position }` (`[x, y, z]` or `{ x, y, z }`, e.g. a physics rigid body, Floater,
   * core mesh, or custom object) to automatically generate entry/exit splashes and swept wakes every frame.
   */
  trackBody(body: RippleTrackedBody, options: RippleTrackOptions = {}): this {
    this.live();
    if (!body || typeof body !== 'object' || readXYZ(body.position) === null)
      throw rippleError('Invalid tracked body; pass an object with a finite position [x, y, z] or { x, y, z }');
    const radius = finite(options.radius ?? Math.max(1, this.cell), this.cell, this.size / 2, 'track radius');
    const strength = finite(options.strength ?? 0.08, -100, 100, 'track strength');
    const halfHeight = finite(options.halfHeight ?? radius, 1e-4, 1e5, 'track halfHeight');
    const splashStrength = finite(options.splashStrength ?? 2.5, 0, 10, 'track splashStrength');
    const minSpeed = finite(options.minSpeed ?? 0.02, 0, 100, 'track minSpeed');
    const volume = options.volume;
    if (volume !== undefined && typeof volume !== 'function')
      throw rippleError("Invalid track volume; pass a function returning the body's submerged m^3");
    // A displacing body is a wall to its own ripples: without it the ring it makes would focus back under it.
    const obstacle = options.obstacle ?? volume !== undefined;
    if (typeof obstacle !== 'boolean') throw rippleError('Invalid track obstacle flag; pass true or false');
    const existing = this.tracked.get(body);
    if (existing) {
      existing.radius = radius;
      existing.strength = strength;
      existing.halfHeight = halfHeight;
      existing.splashStrength = splashStrength;
      existing.minSpeed = minSpeed;
      existing.obstacle = obstacle;
      existing.volume = volume;
    } else {
      const p = readXYZ(body.position)!;
      const surfaceY = this.waterLevelAt(p[0], p[2]);
      const inWater = Math.abs(p[1] - surfaceY) <= halfHeight;
      this.tracked.set(body, {
        radius,
        strength,
        halfHeight,
        splashStrength,
        minSpeed,
        obstacle,
        initialized: true,
        prevX: p[0],
        prevY: p[1],
        prevZ: p[2],
        wasInWater: inWater,
        volume,
        prevVolume: volume ? submerged(volume) : 0,
      });
    }
    this.dirty = true;
    this.surfaceDirty = true;
    return this;
  }
  /** Stop tracking a previously registered body. Safe to call if not tracked. */
  untrackBody(body: RippleTrackedBody): this {
    this.live();
    if (this.tracked.delete(body)) {
      this.dirty = true;
      this.surfaceDirty = true;
    }
    return this;
  }
  /**
   * Configure the GPU debug visualization overlay on the water surface (height or velocity heatmap, solid obstacle
   * masks, active scroll grid outline, and 8-cell absorbing sponge border). Pass `false` to turn off.
   */
  setDebug(options: boolean | RippleDebugOptions): this {
    this.live();
    if (typeof options !== 'boolean' && (typeof options !== 'object' || options === null))
      throw rippleError('Invalid ripple debug options; pass a boolean or { enabled?, mode?, bounds? }');
    const cfg: RippleDebugOptions = typeof options === 'boolean' ? { enabled: options } : options;
    const enabled = cfg.enabled ?? true;
    if (typeof enabled !== 'boolean') throw rippleError('Invalid ripple debug enabled; pass true or false');
    const mode: RippleDebugMode = cfg.mode ?? this.debugState.mode;
    if (!(mode in DEBUG_MODE_INDEX))
      throw rippleError("Invalid ripple debug mode; use 'height', 'velocity', or 'obstacles'");
    const bounds = cfg.bounds ?? this.debugState.bounds;
    if (typeof bounds !== 'boolean') throw rippleError('Invalid ripple debug bounds; pass true or false');
    this.debugState = { enabled, mode, bounds };
    this.surfaceDirty = true;
    return this;
  }
  /**
   * Intersect a world-space ray `(origin, direction)` with the water plane (`surface.seaLevel`) and queue a circular
   * ripple at the hit point. Returns the world hit `[x, y, z]`, or `null` if parallel, behind the ray, or outside the
   * active ripple grid.
   */
  disturbRay(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    radius = Math.max(1, this.cell),
    strength = 0.1,
  ): [number, number, number] | null {
    this.live();
    if (!Array.isArray(origin) || origin.length !== 3 || !Array.isArray(direction) || direction.length !== 3)
      throw rippleError('Invalid ripple ray; pass 3D origin [x, y, z] and direction [dx, dy, dz]');
    for (const v of origin) finite(v, -1e7, 1e7, 'ray origin');
    for (const v of direction) finite(v, -1e7, 1e7, 'ray direction');
    if (Math.hypot(direction[0], direction[1], direction[2]) === 0)
      throw rippleError('Invalid ripple ray direction; pass a nonzero [dx, dy, dz] vector');
    finite(radius, this.cell, this.size / 2, 'radius');
    finite(strength, -100, 100, 'strength');
    if (Math.abs(direction[1]) < 1e-8) return null;
    const planeY = this.surface.seaLevel;
    const t = (planeY - origin[1]) / direction[1];
    if (t < 0 || !Number.isFinite(t)) return null;
    const hx = origin[0] + direction[0] * t;
    const hz = origin[2] + direction[2] * t;
    if (
      hx < this.origin[0] ||
      hx > this.origin[0] + this.size ||
      hz < this.origin[1] ||
      hz > this.origin[1] + this.size
    )
      return null;
    if (this.pending.length < 64 * 8) this.disturb(hx, hz, radius, strength);
    return [hx, planeY, hz];
  }
  private waterLevelAt(x: number, z: number): number {
    return this.surface.sampleHeight(x, z);
  }
  private packObstacles(): void {
    const seaY = this.surface.seaLevel;
    let count = packObstacleList(this.obstacleList, seaY, this.cell, this.packedObstacles);
    for (const [body, state] of this.tracked) {
      if (!state.obstacle || count >= MAX_RIPPLE_OBSTACLES) continue;
      const p = readXYZ(body.position);
      if (p && Math.abs(p[1] - seaY) <= state.halfHeight)
        this.packedObstacles.set([p[0], p[2], state.radius, 0, 0, 0, 1, 0], count++ * 8);
    }
    this.packedObstacleCount = count;
  }
  private sampleTrackedBodies(dt: number): boolean {
    if (!this.tracked.size) return false;
    let emitted = false;
    const safeDt = Math.max(dt, 1 / 120);
    for (const [body, state] of this.tracked) {
      const p = readXYZ(body.position);
      if (!p) continue;
      const [x, y, z] = p;
      const surfaceY = this.waterLevelAt(x, z);
      const inWater = Math.abs(y - surfaceY) <= state.halfHeight;
      if (!state.initialized) {
        state.prevX = x;
        state.prevY = y;
        state.prevZ = z;
        state.wasInWater = inWater;
        state.initialized = true;
        continue;
      }
      const crossed = (state.prevY - surfaceY) * (y - surfaceY) < 0;
      const entered = (!state.wasInWater && inWater) || (!state.wasInWater && !inWater && crossed);
      const exited = state.wasInWater && !inWater;
      const dx = x - state.prevX,
        dy = y - state.prevY,
        dz = z - state.prevZ;
      if (state.volume) {
        // The water the body pushes aside: take back the ring it held where it was, give the one it holds now.
        const now = submerged(state.volume);
        if (this.pending.length > 64 * 8 - 16)
          throw fault('state', 'Ripple event queue full; track at most 32 displacing bodies or render more often');
        if (dx === 0 && dz === 0) {
          if (now !== state.prevVolume) this.displace(x, z, state.radius, now - state.prevVolume);
        } else {
          if (state.prevVolume !== 0) this.displace(state.prevX, state.prevZ, state.radius, -state.prevVolume);
          if (now !== 0) this.displace(x, z, state.radius, now);
        }
        emitted ||= now !== state.prevVolume || ((dx !== 0 || dz !== 0) && now !== 0);
        state.prevVolume = now;
        state.prevX = x;
        state.prevY = y;
        state.prevZ = z;
        state.wasInWater = inWater;
        continue;
      }
      if ((entered || exited) && state.splashStrength > 0 && this.pending.length < 64 * 8) {
        const vy = Math.abs(dy) / safeDt;
        const speedFactor = Math.min(2, 0.4 + vy * 0.25);
        const sign = entered ? (dy <= 0 ? -1 : 1) : 0.6;
        const amp = Math.max(-100, Math.min(100, sign * Math.abs(state.strength) * state.splashStrength * speedFactor));
        if (Math.abs(amp) > 1e-6) {
          this.disturb(x, z, state.radius, amp);
          emitted = true;
        }
      }
      if (inWater && this.pending.length < 64 * 8) {
        const dist = Math.hypot(dx, dz);
        if (dist >= state.minSpeed) {
          const horizSpeed = dist / safeDt;
          const speedScale = Math.min(1.5, 0.25 + horizSpeed * 0.35);
          const amp = Math.max(-100, Math.min(100, -Math.abs(state.strength) * speedScale));
          if (Math.abs(amp) > 1e-6) {
            this.wake([state.prevX, state.prevZ], [x, z], state.radius, amp);
            emitted = true;
          }
        }
      }
      if (state.obstacle && (dx !== 0 || dy !== 0 || dz !== 0)) {
        this.dirty = true;
        this.surfaceDirty = true;
      }
      state.prevX = x;
      state.prevY = y;
      state.prevZ = z;
      state.wasInWater = inWater;
    }
    return emitted;
  }
  private writeSurfaceUniform(device: GPUDevice, origin: readonly [number, number]): void {
    const out = this.surfaceUniformData;
    out[0] = origin[0];
    out[1] = origin[1];
    out[2] = this.cell;
    out[3] = this.resolution;
    out[4] = this.debugState.enabled ? 1 : 0;
    out[5] = DEBUG_MODE_INDEX[this.debugState.mode];
    out[6] = this.debugState.bounds ? 1 : 0;
    out[7] = this.packedObstacleCount;
    out.set(this.packedObstacles, 8);
    device.queue.writeBuffer(this.uniform!, 0, out as Float32Array<ArrayBuffer>);
    this.surfaceDirty = false;
  }
  /** The field's tick rate on a film clock and its substeps a tick: the dyadic rate its stability limit needs. */
  private tickRate(): { rate: number; substeps: number; limit: number } {
    const limit = Math.min(1 / 120, (0.45 * this.cell) / this.speed);
    let rate = 60;
    while (rate < 7680 && 1 / rate > limit) rate *= 2;
    return { rate, substeps: Math.ceil(1 / rate / limit - 1e-9), limit };
  }
  /** The bind groups of config buffer `index`, making the buffer and its groups the first time a step needs it. */
  private configGroups(device: GPUDevice, index: number): GPUBindGroup[] {
    while (this.configs.length <= index) {
      const config = device.createBuffer({
        size: this.parameters.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.buffers.push(config);
      this.configs.push(config);
      this.groups.push(
        [0, 1].map((i) =>
          device.createBindGroup({
            layout: this.pipeline!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: config } },
              { binding: 1, resource: { buffer: this.fields[i] } },
              { binding: 2, resource: { buffer: this.fields[1 - i] } },
            ],
          }),
        ),
      );
    }
    return this.groups[index]!;
  }
  /** A film clock set back: the field starts again from still water at its first place and replays its ticks. */
  private restart(device: GPUDevice): void {
    const zeros = new Uint8Array(this.resolution ** 2 * 8);
    for (const field of this.fields) device.queue.writeBuffer(field, 0, zeros);
    this.origin[0] = this.origin[1] = -this.size / 2;
    this.done = 0;
    this.mirror?.restore({
      origin: this.origin,
      resolution: this.resolution,
      ticks: 0,
      data: new Float32Array(this.resolution ** 2 * 2),
    });
  }
  /** Queue a circular drop. Radius must cover at least one cell, strength is signed metres. */
  disturb(x: number, z: number, radius = 1, strength = 0.1): this {
    return this.wake([x, z], [x, z], radius, strength);
  }
  /**
   * Queue the water a body pushed aside (negative: let back): a ring from `radius` (the body's footprint) out to twice
   * that holding `volume` m^3, so the field's water grows by exactly that. `trackBody` with `volume` queues these itself.
   */
  displace(x: number, z: number, radius: number, volume: number): this {
    this.live();
    for (const v of [x, z]) finite(v, -1e7, 1e7, 'position');
    finite(radius, this.cell / 2, this.size / 4, 'radius');
    finite(volume, -1e9, 1e9, 'volume');
    const height = displacedHeight(volume, radius, 2 * radius);
    if (this.pending.length >= 64 * 8)
      throw fault('state', 'Ripple event queue full; render before adding more than 64 events');
    this.pending.push(x, z, x, z, 2 * radius, height, RIPPLE_DISPLACED, radius);
    const clock = this.surface.options.clock;
    this.due.push(clock ? clock.ticks(this.tickRate().rate) : -1);
    this.dirty = true;
    return this;
  }
  /** Queue a swept capsule from the object's previous XZ to current XZ. Up to 64 events per rendered update. */
  wake(from: readonly [number, number], to: readonly [number, number], radius = 1, strength = 0.1): this {
    this.live();
    if (from.length !== 2 || to.length !== 2) throw rippleError('Invalid wake path; pass two XZ pairs');
    for (const v of [...from, ...to]) finite(v, -1e7, 1e7, 'position');
    finite(radius, this.cell, this.size / 2, 'radius');
    finite(strength, -100, 100, 'strength');
    if (this.pending.length >= 64 * 8)
      throw fault('state', 'Ripple event queue full; render before adding more than 64 events');
    this.pending.push(...from, ...to, radius, strength, 0, 0);
    // On a film clock an event falls due at the clock's tick when it is queued, so it is born at the same instant at any
    // frame rate; without one, in the next step.
    const clock = this.surface.options.clock;
    this.due.push(clock ? clock.ticks(this.tickRate().rate) : -1);
    this.dirty = true;
    return this;
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Ripples already attached; create another Ripples', 'state');
    if (!engine.gpu) throw fault('unsupported', 'Ripples need WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'ripples'))
      throw fault('attached', 'Water already has ripples; dispose them before attaching another field', 'state');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the live Water surface to this engine before Ripples');
    this.engine = engine;
    const device = engine.gpu;
    const make = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage });
      this.buffers.push(buffer);
      return buffer;
    };
    this.fields = Array.from({ length: 3 }, () =>
      make(this.resolution ** 2 * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
    );
    this.uniform = make(this.surfaceUniformData.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.configs = Array.from({ length: 2 }, () =>
      make(this.parameters.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    );
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: compute }), entryPoint: 'main' },
    });
    this.groups = this.configs.map((config) =>
      [0, 1].map((i) =>
        device.createBindGroup({
          layout: this.pipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: config } },
            { binding: 1, resource: { buffer: this.fields[i] } },
            { binding: 2, resource: { buffer: this.fields[1 - i] } },
          ],
        }),
      ),
    );
    this.resources = [{ buffer: this.uniform }, { buffer: this.fields[2] }];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'ripples',
      vertex: true,
      count: 2,
      velocity: 'vec3f(0,rippleSample(base).y,0)',
      shader: (code, binding) => this.shader(code, binding),
      prepare: (c) => {
        this.update(c);
        return this.resources;
      },
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
    this.origin[0] = this.origin[1] = -this.size / 2;
    this.dirty = true;
    this.surfaceDirty = true;
  }
  onPreUpdate(delta: number): void {
    this.delta += Math.max(0, delta);
    this.dirty = true;
  }
  private update(c: Context): void {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Ripples and Water must use the same engine; attach both to one engine');
    if (this.sampleTrackedBodies(this.delta)) this.dirty = true;
    this.packObstacles();
    if (!this.dirty) {
      if (this.surfaceDirty) this.writeSurfaceUniform(c.device, this.origin);
      return;
    }
    const cell = this.cell;
    const next: [number, number] = this.follow
      ? [
          Math.round(c.camera.position[0] / cell) * cell - this.size / 2,
          Math.round(c.camera.position[2] / cell) * cell - this.size / 2,
        ]
      : [-this.size / 2, -this.size / 2];
    const clock = this.surface.options.clock,
      { rate, substeps, limit } = this.tickRate(),
      born: [number, number][] = [],
      later: number[] = [];
    let steps: number, step: number;
    if (clock) {
      const target = clock.ticks(rate);
      if (!Number.isSafeInteger(target) || target < 0)
        throw rippleError(`A Ripples clock gives whole ticks from 0; got ${target}. Pass a FilmClock to the Water.`);
      if (target < this.done) {
        this.restart(c.device);
        for (let e = this.due.length - 1; e >= 0; e--)
          if (this.due[e]! > target) {
            this.due.splice(e, 1);
            this.pending.splice(e * 8, 8);
          }
      }
      const owed = Math.min(WATER_FLOW_TICKS_PER_FRAME, target - this.done);
      if (!(owed > 0)) {
        if (this.surfaceDirty) this.writeSurfaceUniform(c.device, this.origin);
        return;
      }
      for (let e = 0; e < this.due.length; e++) {
        const k = this.due[e]! - this.done;
        if (k >= owed) later.push(e);
        else born.push([Math.max(0, k) * substeps, e]);
      }
      this.done += owed;
      steps = owed * substeps;
      step = 1 / (rate * substeps);
    } else {
      const total = Math.min(0.25, this.delta);
      steps = Math.max(1, Math.ceil(total / limit));
      step = total / steps;
      for (let e = 0; e < this.due.length; e++) born.push([0, e]);
    }
    const write = (index: number, shift: boolean, at: number) => {
      this.parameters.fill(0);
      let count = 0;
      for (const [s, e] of born)
        if (s === at) this.parameters.set(this.pending.slice(e * 8, e * 8 + 8), 16 + 8 * count++);
      this.parameters.set([...next, cell, this.resolution, step, this.speed ** 2, this.damping, count]);
      if (shift)
        new Int32Array(this.parameters.buffer).set(
          [Math.round((next[0] - this.origin[0]) / cell), Math.round((next[1] - this.origin[1]) / cell)],
          8,
        );
      new Uint32Array(this.parameters.buffer)[12] = this.packedObstacleCount;
      if (this.packedObstacleCount > 0)
        this.parameters.set(this.packedObstacles.subarray(0, this.packedObstacleCount * 8), 528);
      this.configGroups(c.device, index);
      c.device.queue.writeBuffer(this.configs[index]!, 0, this.parameters);
    };
    write(0, true, 0);
    write(1, false, -1);
    const extra = new Map<number, number>();
    for (const [s] of born)
      if (s > 0 && !extra.has(s)) {
        extra.set(s, 2 + extra.size);
        write(extra.get(s)!, false, s);
      }
    if (this.mirror) {
      const none = new Float32Array(0),
        shift: [number, number] = [
          Math.round((next[0] - this.origin[0]) / cell),
          Math.round((next[1] - this.origin[1]) / cell),
        ];
      for (let s = 0; s < steps; s++) {
        const events = Float32Array.from(
          born.filter(([at]) => at === s).flatMap(([, e]) => this.pending.slice(e * 8, e * 8 + 8)),
        );
        this.mirror.step({
          origin: next,
          cell,
          dt: step,
          speed2: this.speed ** 2,
          damping: this.damping,
          shift: s === 0 ? shift : [0, 0],
          events: events.length ? events : none,
          eventCount: events.length / 8,
          obstacles: this.packedObstacles,
          obstacleCount: this.packedObstacleCount,
        });
      }
    }
    let input = 0;
    for (let s = 0; s < steps; s++) {
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.groups[s === 0 ? 0 : (extra.get(s) ?? 1)]![input]!);
      pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8));
      pass.end();
      input = 1 - input;
    }
    c.encoder.copyBufferToBuffer(this.fields[input], 0, this.fields[2], 0, this.resolution ** 2 * 8);
    if (input !== 0) c.encoder.copyBufferToBuffer(this.fields[input], 0, this.fields[0], 0, this.resolution ** 2 * 8);
    this.writeSurfaceUniform(c.device, next);
    this.origin[0] = next[0];
    this.origin[1] = next[1];
    const kept = later.flatMap((e) => this.pending.slice(e * 8, e * 8 + 8)),
      keptDue = later.map((e) => this.due[e]!);
    this.pending.length = this.due.length = 0;
    this.pending.push(...kept);
    this.due.push(...keptDue);
    this.delta = 0;
    this.dirty = false;
    this.rendered = true;
  }
  private shader(code: string, binding: number): string {
    const prefix = `
struct RippleSurface { grid:vec4f, debug:vec4f, obstacles:array<vec4f,64> }
@group(0) @binding(${binding}) var<uniform> rippleSurface:RippleSurface;
@group(0) @binding(${binding + 1}) var<storage,read> rippleField:array<vec2f>;
fn rippleAt(p:vec2i)->vec2f {let n=i32(rippleSurface.grid.w);if(any(p<vec2i(0))||any(p>=vec2i(n))){return vec2f(0);}return rippleField[u32(p.y*n+p.x)];}
fn rippleSample(xz:vec2f)->vec2f {let p=(xz-rippleSurface.grid.xy)/rippleSurface.grid.z-0.5;let a=vec2i(floor(p));let t=fract(p);return mix(mix(rippleAt(a),rippleAt(a+vec2i(1,0)),t.x),mix(rippleAt(a+vec2i(0,1)),rippleAt(a+vec2i(1,1)),t.x),t.y);}
// The same obstacle test as the step, on the surface's copy of the packed obstacles, for the debug hatching.
fn rippleSurfaceObstacle(world:vec2f)->bool {
 let count=u32(round(rippleSurface.debug.w));
 for(var i=0u;i<count;i++){
  let o0=rippleSurface.obstacles[i*2u];let o1=rippleSurface.obstacles[i*2u+1u];
  if(o1.z<1.5){let d=world-o0.xy;if(dot(d,d)<=o0.z*o0.z){return true;}}
  else if(o1.z<2.5){let d=world-o0.xy;let lx=d.x*o1.x+d.y*o1.y;let lz=-d.x*o1.y+d.y*o1.x;if(abs(lx)<=o0.z&&abs(lz)<=o0.w){return true;}}
  else{let seg=o0.zw-o0.xy;let t=clamp(dot(world-o0.xy,seg)/max(dot(seg,seg),0.000001),0.0,1.0);let diff=world-o0.xy-t*seg;if(dot(diff,diff)<=o1.x*o1.x){return true;}}
 }
 return false;
}
// Debug view: a signed heat map of the ripple height (0), its vertical velocity (1) or its magnitude (2), with obstacles hatched.
fn rippleDebugOverlay(xz:vec2f,baseColor:vec3f)->vec3f {
 let n=rippleSurface.grid.w;let cell=rippleSurface.grid.z;
 let p=(xz-rippleSurface.grid.xy)/cell;
 if(p.x<0.0||p.y<0.0||p.x>n||p.y>n){return baseColor*0.55;}
 let s=rippleSample(xz);let mode=u32(round(rippleSurface.debug.y));
 var c=baseColor;
 if(mode==0u){
  let v=clamp(s.x*6.0,-1.0,1.0);
  let heat=select(mix(vec3f(0.05,0.16,0.24),vec3f(0.18,0.88,1.0),v),mix(vec3f(0.05,0.16,0.24),vec3f(0.04,0.15,0.85),-v),v<0.0);
  let peak=smoothstep(0.65,1.0,abs(v));
  c=mix(heat,vec3f(1.0,0.96,0.55),peak*0.7);
 }else if(mode==1u){
  let v=clamp(s.y*1.2,-1.0,1.0);
  let heat=select(mix(vec3f(0.07,0.1,0.16),vec3f(0.25,0.95,0.35),v),mix(vec3f(0.07,0.1,0.16),vec3f(0.9,0.18,0.75),-v),v<0.0);
  c=mix(heat,vec3f(1.0,0.98,0.6),smoothstep(0.7,1.0,abs(v))*0.6);
 }else{
  let mag=clamp(abs(s.x)*8.0,0.0,1.0);
  c=mix(vec3f(0.04,0.09,0.14),vec3f(0.28,0.75,0.95),mag);
 }
 if(rippleSurfaceObstacle(xz)){
  let stripe=step(0.5,fract((p.x+p.y)*0.5));
  c=mix(vec3f(0.85,0.22,0.12),vec3f(1.0,0.58,0.18),stripe*0.55);
 }
 // Bounds: the 8-cell absorbing strip tinted magenta, its inner edge and the grid's outer edge drawn as lines.
 if(rippleSurface.debug.z>0.5){
  let edge=min(min(p.x,p.y),min(n-p.x,n-p.y));
  if(edge<8.0){
   let sponge=1.0-edge/8.0;
   c=mix(c,vec3f(0.85,0.22,0.75),sponge*0.32);
  }
  let innerLine=1.0-smoothstep(0.0,0.32,abs(edge-8.0));
  c=mix(c,vec3f(1.0,0.52,0.92),innerLine*0.85);
  let outerLine=1.0-smoothstep(0.0,0.55,edge);
  c=mix(c,vec3f(0.3,0.98,1.0),outerLine*0.95);
 }
 return c;
}
`;
    const withVertex =
      prefix +
      code.replace(
        'return Surface(p,normalize(cross(binormal,tangent)),crest);',
        `
 let rh=rippleSample(xz).x;let rc=rippleSurface.grid.z;
 p.y+=rh;tangent.y+=(rippleSample(xz+vec2f(rc,0)).x-rippleSample(xz-vec2f(rc,0)).x)/(2.0*rc);
 binormal.y+=(rippleSample(xz+vec2f(0,rc)).x-rippleSample(xz-vec2f(0,rc)).x)/(2.0*rc);
 return Surface(p,normalize(cross(binormal,tangent)),crest);`,
      );
    const displayAnchor = 'if(frame.cameraData.w<0.5){color=toDisplay(color);}';
    if (!withVertex.includes(displayAnchor)) return withVertex;
    return withVertex.replace(
      displayAnchor,
      `if(rippleSurface.debug.x>0.5){color=rippleDebugOverlay(i.xz,color);}\n ${displayAnchor}`,
    );
  }
  private cpuField(): RippleField {
    this.live();
    if (!this.mirror) throw fault('state', 'Ripples sample, snapshot and restore need the CPU copy; pass cpu: true');
    return this.mirror;
  }
  /** The ripples alone at world `(x, z)` this frame (`cpu: true`): height, normal and vertical velocity. */
  sampleRipples(x: number, z: number): RippleSample {
    return this.cpuField().sample(x, z);
  }
  /**
   * The surface drawn at world `(x, z)` this frame (`cpu: true`): the Water's surface (`Water.sample`) plus the ripples,
   * so a floating body rides both. Answers on the CPU at once; nothing reads the GPU back.
   */
  sample(x: number, z: number): RippleSurfaceSample {
    const ripple = this.cpuField().sample(x, z),
      water = this.surface.sample(x, z),
      wx = -water.normal[0] / water.normal[1] - ripple.normal[0] / ripple.normal[1],
      wz = -water.normal[2] / water.normal[1] - ripple.normal[2] / ripple.normal[1],
      k = Math.hypot(wx, 1, wz);
    return {
      height: water.height + ripple.height,
      normal: [-wx / k, 1 / k, -wz / k],
      velocity: [water.velocity[0], water.velocity[1] + ripple.velocity, water.velocity[2]],
    };
  }
  /** World Y of the surface drawn at `(x, z)` this frame (`cpu: true`). */
  sampleHeight(x: number, z: number): number {
    return this.sample(x, z).height;
  }
  /** A copy of the field's state this frame (`cpu: true`), with its film-clock ticks. */
  snapshot(): RippleSnapshot {
    const state = this.cpuField().snapshot();
    return Object.freeze({ ...state, ticks: this.done });
  }
  /**
   * Puts a snapshot back on the CPU and the GPU (`cpu: true`); queued events are dropped. The next frame continues from
   * it, so a replay from a snapshot draws the same field.
   */
  restore(snapshot: RippleSnapshot): this {
    const field = this.cpuField().restore(snapshot);
    this.origin[0] = field.origin[0];
    this.origin[1] = field.origin[1];
    this.done = snapshot.ticks;
    this.pending.length = this.due.length = 0;
    const device = this.engine?.gpu;
    if (device && this.fields.length) {
      const data = snapshot.data as Float32Array<ArrayBuffer>;
      device.queue.writeBuffer(this.fields[0]!, 0, data);
      device.queue.writeBuffer(this.fields[2]!, 0, data);
    }
    this.dirty = this.surfaceDirty = true;
    return this;
  }
  /** FNV-1a of the CPU copy's bits, origin and steps (`cpu: true`): equal for equal fields. */
  stateHash(): string {
    return this.cpuField().stateHash();
  }
  /** Read the submitted GPU field without advancing it. Supports cancellation and one pending read. */
  async readFrame(options: { signal?: AbortSignal } = {}): Promise<RippleFrame> {
    this.live();
    options.signal?.throwIfAborted();
    if (!this.engine?.gpu || !this.rendered) throw fault('state', 'Render the water before reading ripples');
    if (this.reading) throw fault('state', 'Ripple read pending; await it before reading again');
    const device = this.engine.gpu,
      generation = this.generation,
      origin = Object.freeze([...this.origin]) as readonly [number, number];
    const buffer = device.createBuffer({
      size: this.resolution ** 2 * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.reading = true;
    const abort = () => buffer.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.fields[2], 0, buffer, 0, buffer.size);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      options.signal?.throwIfAborted();
      this.live();
      if (generation !== this.generation)
        throw fault('state', 'Ripple device restored during read; render and read again');
      return Object.freeze({
        origin,
        resolution: this.resolution,
        cellSize: this.cell,
        data: new Float32Array(buffer.getMappedRange().slice(0)),
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      this.live();
      if (generation !== this.generation)
        throw fault('state', 'Ripple device restored during read; render and read again');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      buffer.destroy();
      this.reading = false;
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Ripples disposed; create another Ripples');
  }
  private release(): void {
    this.remove?.();
    this.remove = undefined;
    this.removeDispose?.();
    this.removeDispose = undefined;
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers = [];
    this.fields = [];
    this.configs = [];
    this.groups = [];
    this.resources = [];
    this.rendered = false;
    this.generation++;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracked.clear();
    this.obstacleList = [];
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
