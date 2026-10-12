import type {EngineKernel, Mesh, Vec3} from '@margoengine/core';
import {engineRuntime, meshRuntime, type Engine, type EnginePlugin} from '@margoengine/core/extension';

export interface CinematicOptions {offset?: Vec3; damping?: number; lookDamping?: number; ground?: (x: number, z: number) => number; clearance?: number}
const valid = (vector: ArrayLike<number>): void => {if (vector.length !== 3) throw new TypeError('Expected 3D target'); for (let i = 0; i < 3; i++) if (!Number.isFinite(vector[i])) throw new RangeError('Target must be finite');};

/** Critically damped virtual camera, with independent follow/look springs and additive shake. */
export class Cinematic implements EnginePlugin {
  readonly name = 'cinematic';
  readonly offset: Float64Array;
  readonly position = new Float64Array(3);
  readonly lookAt = new Float64Array(3);
  private readonly velocity = new Float64Array(6);
  private readonly target = new Float64Array(3);
  private readonly cameraPosition = new Float32Array(3);
  private readonly cameraTarget = new Float32Array(3);
  private engine?: Engine;
  private mesh?: Mesh;
  private amplitude = 0;
  private remaining = 0;
  private shakeDuration = 1;
  private frequency = 25;
  private time = 0;
  private initialized = false;
  constructor(readonly options: CinematicOptions = {}) {
    const offset = options.offset ?? [0, 3, 6]; valid(offset);
    if (!Number.isFinite(options.damping ?? 6) || (options.damping ?? 6) <= 0 || !Number.isFinite(options.lookDamping ?? 8) || (options.lookDamping ?? 8) <= 0) throw new RangeError('Invalid camera damping');
    if (!Math.hypot(offset[0], offset[1], offset[2])) throw new RangeError('Camera offset cannot be zero');
    this.validateGround();
    this.offset = new Float64Array(offset);
  }
  static attach(engine: EngineKernel, options: CinematicOptions = {}): Cinematic {const rig = new Cinematic(options); engineRuntime(engine).use(rig); return rig;}
  setOrbitOffset(yaw: number, pitch: number, distance: number, height = 0): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(distance) || distance <= 0 || !Number.isFinite(height)) throw new RangeError('Invalid camera orbit');
    this.offset[0] = Math.sin(yaw)*Math.cos(pitch)*distance;
    this.offset[1] = Math.sin(pitch)*distance+height;
    this.offset[2] = Math.cos(yaw)*Math.cos(pitch)*distance;
  }
  follow(target: Mesh | Vec3): void {
    if (Array.isArray(target)) {valid(target); this.target.set(target); this.mesh = undefined;}
    else {const mesh = meshRuntime(target as Mesh); mesh.check(); if (this.engine && mesh.engine !== this.engine) throw new TypeError('Target belongs to another engine'); this.mesh = target as Mesh;}
  }
  shake(amplitude: number, duration: number, frequency = 25): void {
    if (!Number.isFinite(amplitude) || amplitude < 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(frequency) || frequency <= 0) throw new RangeError('Invalid camera shake');
    this.amplitude = amplitude; this.remaining = this.shakeDuration = duration; this.frequency = frequency;
  }
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid camera delta');
    valid(this.offset);
    this.validateGround();
    const follow = this.options.damping ?? 6, look = this.options.lookDamping ?? 8;
    if (!Number.isFinite(follow) || follow <= 0 || !Number.isFinite(look) || look <= 0) throw new RangeError('Invalid camera damping');
    if (this.mesh) {
      const mesh = meshRuntime(this.mesh); mesh.check(); mesh.engine.store.tick(false);
      this.target[0] = mesh.matrix[12]; this.target[1] = mesh.matrix[13]; this.target[2] = mesh.matrix[14];
    }
    const offsetY = this.groundOffset(this.target, this.offset[0], this.offset[1], this.offset[2]);
    for (let i = 0; i < 3; i++) {
      const offset = i === 1 ? offsetY : this.offset[i];
      if (!this.initialized) {this.position[i] = this.target[i] + offset; this.lookAt[i] = this.target[i];}
      for (let kind = 0; kind < 2; kind++) {
        const values = kind ? this.lookAt : this.position, goal = this.target[i] + (kind ? 0 : offset), omega = kind ? look : follow, j = kind * 3 + i;
        const error = values[i] - goal, derivative = this.velocity[j] + omega * error, decay = Math.exp(-omega * delta);
        values[i] = goal + (error + derivative * delta) * decay; this.velocity[j] = (this.velocity[j] - omega * derivative * delta) * decay;
      }
    }
    this.initialized = true; this.time += delta; this.remaining = Math.max(0, this.remaining - delta);
    const shake = this.amplitude * (this.remaining / this.shakeDuration) ** 2;
    for (let i = 0; i < 3; i++) {this.cameraPosition[i] = this.position[i] + Math.sin(this.time * this.frequency * (1 + i * 0.37) + i * 2) * shake; this.cameraTarget[i] = this.lookAt[i];}
    const dy = this.cameraPosition[1] - this.lookAt[1];
    const lift = this.groundOffset(this.lookAt, this.cameraPosition[0] - this.lookAt[0], dy, this.cameraPosition[2] - this.lookAt[2]) - dy;
    if (lift > 0) {this.cameraPosition[1] += lift; this.position[1] += lift; this.velocity[1] = Math.max(0, this.velocity[1]);}
    if (this.engine) {this.engine.camera.position = this.cameraPosition as unknown as Vec3; this.engine.camera.target = this.cameraTarget as unknown as Vec3;}
  }
  private validateGround(): void {
    if (this.options.ground !== undefined && typeof this.options.ground !== 'function' || !Number.isFinite(this.options.clearance ?? 0.65) || (this.options.clearance ?? 0.65) < 0) throw new RangeError('Invalid camera ground clearance');
  }
  private groundOffset(origin: ArrayLike<number>, dx: number, dy: number, dz: number): number {
    const ground = this.options.ground;
    if (ground) {
      // shortcut: six samples can miss narrow ridges; use collision geometry for detailed obstacles.
      for (let i = 1; i <= 6; i++) {
        const t = i / 6, height = ground(origin[0] + dx * t, origin[2] + dz * t);
        if (!Number.isFinite(height)) throw new RangeError('Camera ground height must be finite');
        dy = Math.max(dy, (height + (this.options.clearance ?? 0.65) - origin[1]) / t);
      }
    }
    return dy;
  }
  setup(engine: Engine): void {
    if (this.engine) throw new Error('Camera rig already attached');
    if (this.mesh && meshRuntime(this.mesh).engine !== engine) throw new TypeError('Target belongs to another engine');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {this.update(delta);}
  dispose(): void {const engine = this.engine; this.engine = undefined; this.mesh = undefined; engine?.removePlugin(this.name);}
}
