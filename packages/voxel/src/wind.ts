/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { BlockTypes, BlockTypeOptions } from './blocks.js';
import type { VoxelRenderer, VoxelVertexMotion } from './render.js';
import type { VoxelBlockMotion } from './wind-data.js';

export type { VoxelBlockMotion } from './wind-data.js';
/** Per-block foliage or liquid vertex animation. */
export interface VoxelWindBlockOptions {
  /** Default foliage for non-liquids, liquid for liquid shapes. */
  kind?: 'foliage' | 'liquid';
  /** Maximum displacement in blocks, 0..0.5. Default 0.12 for foliage, 0.04 for liquid. */
  amplitude?: number;
  /** Angular speed, 0..100 radians/second. Default 1.6. */
  speed?: number;
  /** Angular spatial frequency, 0..100 radians/block. Default 1.3. */
  frequency?: number;
  /** Anchors foliage at the cell floor. Default true for crosses, false otherwise. */
  rooted?: boolean;
}
const scalar = (n: number, name: string, max: number): number => {
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new RangeError(`Voxel wind ${name} must be finite in 0..${max}; correct the option`);
  return n;
};
/** Defines a block with prepared motion metadata; animated faces remain unit quads to keep shared wave edges joined. */
export function defineWindBlock(
  blocks: BlockTypes,
  name: string,
  options: BlockTypeOptions = {},
  motion: VoxelWindBlockOptions = {},
): number {
  const kind = motion.kind ?? (options.shape === 'liquid' ? 'liquid' : 'foliage');
  if (kind !== 'foliage' && kind !== 'liquid')
    throw new TypeError('Wind kind must be foliage or liquid; select one of those');
  if (kind === 'liquid' && options.shape !== 'liquid')
    throw new TypeError('Liquid wind motion needs a liquid shape; pass {shape: "liquid"} or choose foliage motion');
  if (options.shape === 'model' || options.shape === 'object')
    throw new TypeError('Wind blocks use cube, cross, liquid, slab or stair shapes; use those shapes');
  const rooted = motion.rooted ?? options.shape === 'cross';
  if (typeof rooted !== 'boolean') throw new TypeError('Wind rooted must be true or false; pass a boolean');
  const vertexMotion: VoxelBlockMotion = {
    kind,
    rooted,
    amplitude: scalar(motion.amplitude ?? (kind === 'liquid' ? 0.04 : 0.12), 'amplitude', 0.5),
    speed: scalar(motion.speed ?? 1.6, 'speed', 100),
    frequency: scalar(motion.frequency ?? 1.3, 'frequency', 100),
  };
  return blocks.define(name, { ...options, vertexMotion });
}

/** XZ wind direction/strength and optional explicit animation clock. */
export interface VoxelWindOptions {
  /** XZ vector, default [1,0]. Length below 1 scales displacement, zero stops it; length above 1 is normalized. */
  direction?: readonly [number, number];
  /** Explicit seconds, in +/-1e6. Default renderer time; use undefined to return to that clock. */
  time?: number;
}

/** CPU reference of the GPU motion, for tools and deterministic seam checks. Returns an offset, in blocks. */
export function sampleVoxelWind(
  motion: VoxelBlockMotion,
  position: readonly [number, number, number],
  cellFloor: number,
  time: number,
  direction: readonly [number, number] = [1, 0],
  surface = true,
): [number, number, number] {
  if (
    !position.every(Number.isFinite) ||
    !Number.isFinite(cellFloor) ||
    !Number.isFinite(time) ||
    direction.length !== 2 ||
    !direction.every(Number.isFinite)
  )
    throw new RangeError('Wind sample needs finite position, floor, time and XZ direction; pass finite numbers');
  const length = Math.hypot(...direction),
    strength = Math.min(1, length),
    dx = length ? direction[0] / length : 0,
    dz = length ? direction[1] / length : 0,
    phase = (position[0] * dx + position[2] * dz) * motion.frequency + time * motion.speed;
  if (!strength || !motion.amplitude) return [0, 0, 0];
  if (motion.kind === 'liquid')
    return [
      0,
      surface ? (motion.amplitude * strength * (Math.sin(phase) + 0.5 * Math.sin(1.7 * phase + 1.2))) / 1.5 : 0,
      0,
    ];
  const h = Math.max(0, Math.min(1, position[1] - cellFloor)),
    weight = motion.rooted ? h * h * (3 - 2 * h) : 1,
    bend = motion.amplitude * strength * weight * (0.75 * Math.sin(phase) + 0.25 * Math.sin(1.91 * phase + 0.73));
  return [dx * bend || 0, 0, dz * bend || 0];
}

/** GPU vertex motion for a VoxelRenderer, shared by beauty, surface capture and shadows. */
export class VoxelWind implements VoxelVertexMotion {
  private readonly values = new Float32Array([1, 0, 0, 0]);
  private gpu?: { device: GPUDevice; buffer: GPUBuffer };
  private readonly cache = new Map<string, string>();
  private count = -1;
  private paddingVersion = -1;
  private radius = 0;
  private dirty = true;
  private disposed = false;
  private readonly off: () => void;
  private readonly offDispose: () => void;
  constructor(
    readonly renderer: VoxelRenderer,
    options: VoxelWindOptions = {},
  ) {
    this.direction = options.direction ?? [1, 0];
    this.time = options.time;
    this.off = renderer.addVertexMotion(this);
    this.offDispose = renderer.onDispose(() => this.dispose());
  }
  /** Live XZ wind; a copy is returned. */
  get direction(): readonly [number, number] {
    return [this.values[0], this.values[1]];
  }
  set direction(value: readonly [number, number]) {
    this.check();
    if (value?.length !== 2 || !value.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e4))
      throw new RangeError('Wind direction must be two finite XZ components within +/-10000; pass [x,z]');
    this.values[0] = value[0];
    this.values[1] = value[1];
    this.dirty = true;
  }
  /** Explicit clock, or undefined for the renderer clock. */
  get time(): number | undefined {
    return this.values[3] ? this.values[2] : undefined;
  }
  set time(value: number | undefined) {
    this.check();
    if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1e6))
      throw new RangeError('Wind time must be finite within +/-1e6 seconds; pass time or undefined for renderer time');
    this.values[2] = value ?? 0;
    this.values[3] = value === undefined ? 0 : 1;
    this.dirty = true;
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'VoxelWind is disposed; create another VoxelWind');
  }
  /** Conservative bounds padding. */
  get padding(): number {
    if (this.paddingVersion !== this.version) {
      this.paddingVersion = this.version;
      this.radius = this.renderer.world.blocks.table.reduce((n, t) => Math.max(n, t.vertexMotion?.amplitude ?? 0), 0);
    }
    return this.radius;
  }
  /** Shader definition version; adding a block type refreshes material ids. */
  get version(): number {
    return this.renderer.world.blocks.table.length;
  }
  /** Renderer adapter: creates/restores one owned uniform buffer and uploads live direction/time. */
  bindings(device: GPUDevice): GPUBindGroupEntry[] {
    this.check();
    if (this.gpu?.device !== device) {
      this.gpu?.buffer.destroy();
      this.gpu = { device, buffer: device.createBuffer({ size: 16, usage: 64 | 8 }) };
      this.dirty = true;
    }
    if (this.dirty) {
      device.queue.writeBuffer(this.gpu.buffer, 0, this.values);
      this.dirty = false;
    }
    return [{ binding: 11, resource: { buffer: this.gpu.buffer } }];
  }
  /** Renderer adapter: composes motion with the existing voxel shader without changing static worlds. */
  shader(code: string): string {
    this.check();
    if (this.count !== this.version) {
      this.count = this.version;
      this.cache.clear();
    }
    const cached = this.cache.get(code);
    if (cached) return cached;
    let next = code;
    if (code.includes('fn voxelPlace(')) {
      next = next.replaceAll(
        /voxelPlace\(w0,w1,(c(?:\^1u)?|3u-c),t\)/g,
        (_, corner) => `windPlace(w0,w1,${corner},t,voxelOrigins[voxelPages[q>>6u]].xyz)`,
      );
      if (code.includes('struct Out {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) words:vec3u')) {
        next = next.replace(
          '@location(3) @interpolate(flat) maps:vec4u}',
          '@location(3) @interpolate(flat) maps:vec4u,@location(4) windBase:vec3f,@location(5) windWorld:vec3f}',
        );
        next = next.replace(
          'var o:Out;o.clip=clip;',
          'var o:Out;o.windBase=origin.xyz+windBase(w0,w1,c,t);o.windWorld=origin.xyz+windPlace(w0,w1,c,t,origin.xyz);o.clip=clip;',
        );
        next = next.replace(
          'i.position=voxelHit(o.clip.xy,n,k);let l=i.position-O;',
          'i.position=select(voxelHit(o.clip.xy,n,k),o.windWorld,windInfo(w.y&4095u).x>0.0);let l=select(i.position,o.windBase,windInfo(w.y&4095u).x>0.0)-O;',
        );
        next = next.replace(
          'let dx=voxelTile(face,voxelHit(o.clip.xy+vec2f(1.0,0.0),n,k)-O,cell)-uv;let dy=voxelTile(face,voxelHit(o.clip.xy+vec2f(0.0,1.0),n,k)-O,cell)-uv;',
          'let dx=select(voxelTile(face,voxelHit(o.clip.xy+vec2f(1.0,0.0),n,k)-O,cell)-uv,dpdx(uv),windInfo(w.y&4095u).x>0.0);let dy=select(voxelTile(face,voxelHit(o.clip.xy+vec2f(0.0,1.0),n,k)-O,cell)-uv,dpdy(uv),windInfo(w.y&4095u).x>0.0);',
        );
        next = next.replace(
          'let side=select(-1.0,1.0,front);',
          'let windN=cross(dpdx(o.windWorld),dpdy(o.windWorld));let side=select(-1.0,1.0,front);',
        );
        const normal = 'if(face==2u&&(w.y&0x100000u)!=0u){normal=voxelRipple(i.position.xz,t)*side;}';
        next = next.replace(
          normal,
          normal +
            '\n if(windInfo(w.y&4095u).x>0.0&&dot(windN,windN)>0.0){normal=normalize(windN)*select(-1.0,1.0,dot(windN,normal)>=0.0);}\n',
        );
      }
      next += `\nfn windBase(w0:u32,w1:u32,c:u32,t:f32)->vec3f {var p=voxelPlace(w0,w1,c,t);let face=(w0>>15u)&7u;if(windInfo(w1&4095u).x==2.0&&(face==2u||(face!=3u&&face<6u&&c>=2u))){p.y-=voxelRise(w1,t);}return p;}
fn windPlace(w0:u32,w1:u32,c:u32,t:f32,O:vec3f)->vec3f {let p=windBase(w0,w1,c,t);let face=(w0>>15u)&7u;let surface=(w1&0x100000u)!=0u&&(face==2u||(face!=3u&&face<6u&&c>=2u));return p+windOffset(O+p,O.y+f32((w0>>5u)&31u),w1&4095u,t,surface);}\n`;
    }
    if (code.includes('o.clip=f.camera*vec4f(v.p,1.0)')) {
      next = next
        .replace(
          'o.clip=f.camera*vec4f(v.p,1.0)',
          'o.clip=f.camera*vec4f(v.p+windOffset(v.p,floor(v.p.y),v.material&4095u,f.glow.w,true),1.0)',
        )
        .replace('o.world=v.p;', 'o.world=v.p+windOffset(v.p,floor(v.p.y),v.material&4095u,f.glow.w,true);');
    }
    if (code.includes('shadow.matrix*vec4f(p,1.0)'))
      next = next.replace(
        'shadow.matrix*vec4f(p,1.0)',
        'shadow.matrix*vec4f(p+windOffset(p,floor(p.y),material&4095u,shadow.time.x,true),1.0)',
      );
    const types = this.renderer.world.blocks.table;
    let material = 0,
      cases = '',
      roots = '';
    for (const type of types) {
      if (type.layer === 'invisible') continue;
      for (let face = 0; face < 6; face++)
        if (type.textures.indexOf(type.textures[face]) === face) {
          const m = type.vertexMotion;
          if (m) {
            cases += `case ${material}u:{return vec4f(${m.kind === 'liquid' ? '2.0' : '1.0'},${m.amplitude},${m.frequency},${m.speed});}\n`;
            if (m.rooted) roots += `case ${material}u:{return true;}\n`;
          }
          material++;
        }
    }
    const header = `
struct WindFrame {data:vec4f}
@group(0) @binding(11) var<uniform> windFrame:WindFrame;
fn windInfo(m:u32)->vec4f {switch m {${cases} default:{return vec4f(0.0);}}}
fn windRoot(m:u32)->bool {switch m {${roots} default:{return false;}}}
fn windOffset(p:vec3f,floorY:f32,material:u32,clock:f32,surface:bool)->vec3f {
 let config=windInfo(material);let magnitude=length(windFrame.data.xy);let direction=windFrame.data.xy/max(magnitude,0.000001);let strength=min(magnitude,1.0);
 let time=select(clock,windFrame.data.z,windFrame.data.w>0.5);let phase=dot(p.xz,direction)*config.z+time*config.w;
 if(config.x==2.0){return vec3f(0.0,select(0.0,config.y*strength*(sin(phase)+0.5*sin(1.7*phase+1.2))/1.5,surface),0.0);}
 let h=clamp(p.y-floorY,0.0,1.0);let weight=select(1.0,h*h*(3.0-2.0*h),windRoot(material));let bend=config.y*strength*weight*(0.75*sin(phase)+0.25*sin(1.91*phase+0.73));return vec3f(direction.x*bend,0.0,direction.y*bend);
}
`;
    next = header + next;
    this.cache.set(code, next);
    return next;
  }
  /** Removes motion before releasing its GPU uniform buffer. Block metadata and fine tessellation remain. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.offDispose();
    this.gpu?.buffer.destroy();
    this.gpu = undefined;
    this.cache.clear();
  }
  /** Removes and releases the wind feature. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
