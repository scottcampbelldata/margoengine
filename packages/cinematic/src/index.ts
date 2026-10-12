import type {EngineKernel, Mesh, Vec3} from '@margoengine/core';
import {engineRuntime, meshRuntime, type Engine, type EnginePlugin} from '@margoengine/core/extension';

export interface CinematicOptions {offset?: Vec3; damping?: number; lookDamping?: number}
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
    this.offset = new Float64Array(offset);
  }
  static attach(engine: EngineKernel, options: CinematicOptions = {}): Cinematic {const rig = new Cinematic(options); engineRuntime(engine).use(rig); return rig;}
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
    const follow = this.options.damping ?? 6, look = this.options.lookDamping ?? 8;
    if (!Number.isFinite(follow) || follow <= 0 || !Number.isFinite(look) || look <= 0) throw new RangeError('Invalid camera damping');
    if (this.mesh) {
      const mesh = meshRuntime(this.mesh); mesh.check(); mesh.engine.store.tick(false);
      this.target[0] = mesh.matrix[12]; this.target[1] = mesh.matrix[13]; this.target[2] = mesh.matrix[14];
    }
    for (let i = 0; i < 3; i++) {
      if (!this.initialized) {this.position[i] = this.target[i] + this.offset[i]; this.lookAt[i] = this.target[i];}
      for (let kind = 0; kind < 2; kind++) {
        const values = kind ? this.lookAt : this.position, goal = this.target[i] + (kind ? 0 : this.offset[i]), omega = kind ? look : follow, j = kind * 3 + i;
        const error = values[i] - goal, derivative = this.velocity[j] + omega * error, decay = Math.exp(-omega * delta);
        values[i] = goal + (error + derivative * delta) * decay; this.velocity[j] = (this.velocity[j] - omega * derivative * delta) * decay;
      }
    }
    this.initialized = true; this.time += delta; this.remaining = Math.max(0, this.remaining - delta);
    const shake = this.amplitude * (this.remaining / this.shakeDuration) ** 2;
    for (let i = 0; i < 3; i++) {this.cameraPosition[i] = this.position[i] + Math.sin(this.time * this.frequency * (1 + i * 0.37) + i * 2) * shake; this.cameraTarget[i] = this.lookAt[i];}
    if (this.engine) {this.engine.camera.position = this.cameraPosition as unknown as Vec3; this.engine.camera.target = this.cameraTarget as unknown as Vec3;}
  }
  setup(engine: Engine): void {
    if (this.engine) throw new Error('Camera rig already attached');
    if (this.mesh && meshRuntime(this.mesh).engine !== engine) throw new TypeError('Target belongs to another engine');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {this.update(delta);}
  dispose(): void {const engine = this.engine; this.engine = undefined; this.mesh = undefined; engine?.removePlugin(this.name);}
}
