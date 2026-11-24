// The 2D kernel's Wasm and its typed calls. Physics2D.load() imports this module lazily, nothing else does. The Wasm is
// `dist/physics2d.wasm`, a file of its own that bundlers emit as an asset and browsers compile while it downloads
// (WebAssembly.instantiateStreaming). Numbers cross the boundary through one shared word buffer (kernel/src/api.rs).
import { MargoError } from '@margoengine/math/errors';
import { instantiateKernel, type KernelWasmSource } from './wasm-load.js';

export type { KernelWasmSource };

/**
 * The Wasm this package ships, beside this chunk in dist. The literal reaches the app's bundler unchanged, which emits
 * the file as an asset; `?no-inline` keeps Vite (in library mode too) from inlining it as base64.
 */
export const defaultWasm = (): URL => new URL(/* @vite-ignore */ './physics2d.wasm?no-inline', import.meta.url);
// The interface version the kernel reports and a hash of its Wasm's exports and imports, swapped in by the package build.
declare const __KERNEL_VERSION__: string;
declare const __KERNEL_INTERFACE__: number;

interface Exports {
  memory: WebAssembly.Memory;
  api_version(): number;
  io_reserve(words: number): number;
  world_create(gx: number, gy: number): number;
  world_destroy(world: number): number;
  world_set_gravity(world: number, gx: number, gy: number): number;
  world_step(world: number, dt: number): number;
  body_create(world: number, kind: number, flags: number): number;
  body_remove(world: number, body: number): number;
  body_read(world: number, body: number): number;
  body_read_poses(world: number, count: number): number;
  body_set_transform(world: number, body: number, x: number, y: number, c: number, s: number): number;
  body_set_velocity(world: number, body: number, vx: number, vy: number, av: number): number;
  body_impulse(world: number, body: number, jx: number, jy: number, has: number, px: number, py: number): number;
  body_torque_impulse(world: number, body: number, torque: number): number;
  body_add_force(world: number, body: number, fx: number, fy: number, torque: number): number;
  body_reset_forces(world: number, body: number): number;
  body_set_params(world: number, body: number, ld: number, ad: number, gs: number, flags: number, dominance: number): number;
  body_set_fixed_rotation(world: number, body: number, fixed: number): number;
  body_set_next(world: number, body: number, x: number, y: number, c: number, s: number): number;
  body_wake(world: number, body: number): number;
  body_sleep(world: number, body: number): number;
  body_set_additional_mass(world: number, body: number, mass: number): number;
  body_set_kind(world: number, body: number, kind: number): number;
  body_set_soft_ccd(world: number, body: number, distance: number): number;
  project_point(world: number): number;
  aabb_query(world: number): number;
  contacts_of(world: number, shape: number): number;
  world_set_hooks(world: number, on: number): number;
  world_snapshot(world: number): number;
  world_restore(world: number, bytes: number): number;
  debug_lines(world: number, what: number): number;
  shape_create(world: number, body: number, kind: number): number;
  shape_remove(world: number, shape: number): number;
  shape_set(world: number, shape: number): number;
  shape_read(world: number, shape: number): number;
  joint_create(world: number, a: number, b: number, collide: number): number;
  joint_remove(world: number, joint: number): number;
  joint_set_limits(world: number, joint: number, has: number, lo: number, hi: number): number;
  joint_set_motor(world: number, joint: number, has: number): number;
  events_read(world: number): number;
  force_events_read(world: number): number;
  ray_cast(world: number): number;
  point_query(world: number): number;
  shape_overlap(world: number, kind: number): number;
  shape_cast(world: number, kind: number): number;
}

/** Kernel error codes, in the order of `PhysicsError` in kernel/src/error.rs. */
const CODES = [
  ['PHYSICS2D_NOT_FINITE', 'a number is not finite; fix the value'],
  ['PHYSICS2D_INVALID_CORE', 'the shape is not a valid collider; check its size and points'],
  ['PHYSICS2D_DEGENERATE', 'the shape has no area or length, or its outline crosses itself; fix the points'],
  ['PHYSICS2D_ARITHMETIC_OVERFLOW', 'a value is too large to simulate; use smaller sizes, densities and speeds'],
  ['PHYSICS2D_INVALID_HANDLE', 'the body, collider or joint was removed or never existed'],
  ['PHYSICS2D_INVALID_PARAMETER', 'a value is outside its range'],
] as const;

/** The kernel's error as a coded exception; argument errors are RangeErrors, a stale handle is a state error. */
function kernelError(code: number): Error {
  const [name, help] = CODES[-code - 1] ?? ['PHYSICS2D_UNKNOWN', 'the kernel refused the call'];
  if (name === 'PHYSICS2D_INVALID_HANDLE') return new MargoError('state', `Physics2D: ${help}. (${name})`);
  return Object.assign(new RangeError(`Physics2D: ${help}. (${name})`), { code: name });
}

/** The two questions the kernel puts to the page while it steps (see `Physics2D.hooks`). @internal */
export interface KernelHooks {
  filter(a: number, b: number): boolean;
  /** Answers through the buffer: friction, restitution, a one-way direction; returns the bits of what it set. */
  contact(a: number, b: number, nx: number, ny: number, points: number): number;
}

/** One word of the buffer as a float or as an integer. */
export interface Words {
  readonly f: Float32Array;
  readonly u: Uint32Array;
}

/** The kernel's exports with their errors thrown. One per app; worlds are handles into it. */
export class Kernel {
  private at = 0;
  /** What the kernel asks of the page while it steps: whether a pair may meet, and how to change a contact. @internal */
  hooks: KernelHooks | null = null;
  /** @internal */
  constructor(private readonly x: Exports) {}
  /** The buffer's words, at least `words` long. Read it again after any call: memory may have grown. */
  io(words: number): Words {
    const at = (this.at = this.x.io_reserve(words));
    const buffer = this.x.memory.buffer;
    return { f: new Float32Array(buffer, at, words), u: new Uint32Array(buffer, at, words) };
  }
  /** @internal The buffer as it was last given out, for a hook that runs inside a call (no call into the kernel). */
  current(words: number): Words {
    const buffer = this.x.memory.buffer;
    return { f: new Float32Array(buffer, this.at, words), u: new Uint32Array(buffer, this.at, words) };
  }
  /** The checked result of a call: its non-negative value, or the kernel's error thrown. */
  ok(result: number): number {
    if (result < 0) throw kernelError(result);
    return result;
  }
  get exports(): Exports {
    return this.x;
  }
}

/** Compiles the kernel's Wasm from `source` and returns the ready kernel. `signal` cancels the download and the wait. */
export async function startKernel(source: KernelWasmSource, signal: AbortSignal): Promise<Kernel> {
  let kernel: Kernel | null = null;
  const exports = await instantiateKernel(source, signal, {
    file: 'physics2d.wasm',
    version: __KERNEL_VERSION__,
    interface: __KERNEL_INTERFACE__,
    imports: {
      env: {
        hook_filter: (a: number, b: number) => (kernel?.hooks ? (kernel.hooks.filter(a, b) ? 1 : 0) : 1),
        hook_contact: (a: number, b: number, nx: number, ny: number, points: number) =>
          kernel?.hooks ? kernel.hooks.contact(a, b, nx, ny, points) : 0,
      },
    },
  });
  kernel = new Kernel(exports as unknown as Exports);
  return kernel;
}
