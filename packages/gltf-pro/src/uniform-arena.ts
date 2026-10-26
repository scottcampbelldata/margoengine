// One uniform arena per device for every PBR draw. A model used to own one small GPU buffer per primitive and write it
// with its own `queue.writeBuffer` each frame: 10,000 meshes made 10,000 queue writes (and copy commands) per frame.
// A slot is a window of a large buffer instead. A draw copies its values into the arena's CPU copy (marking the slot
// dirty only if a value changed) and `flushUniforms` uploads each chunk's changed range with a single write.
import { currentFrame, retire } from '../../shared/frame-resources.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** Bytes per slot unit: the device's uniform offset alignment, 256 on every WebGPU implementation seen. */
const MIN_UNIT = 256;
/** The smallest chunk (in units) and the largest (4 MiB at 256 B): chunks never move, so bind groups stay valid. */
const FIRST_CHUNK = 256;
const LAST_CHUNK = 16384;

interface Chunk {
  buffer: GPUBuffer;
  cpu: Float32Array<ArrayBuffer>;
  /** Slots handed out so far (bump pointer, in units) and slots in use. */
  used: number;
  live: number;
  units: number;
  /** Changed float range [lo, hi) since the last flush. */
  lo: number;
  hi: number;
  free: Map<number, number[]>;
}

class Arena {
  readonly unit: number;
  readonly chunks: Chunk[] = [];
  dirty = false;
  constructor(readonly device: GPUDevice) {
    this.unit = Math.max(MIN_UNIT, device.limits?.minUniformBufferOffsetAlignment ?? MIN_UNIT);
  }
  allocate(floats: number): UniformSlot {
    const units = Math.ceil((floats * 4) / this.unit);
    for (const chunk of this.chunks) {
      const reuse = chunk.free.get(units)?.pop();
      if (reuse !== undefined) return new UniformSlot(this, chunk, reuse, floats, units);
      if (chunk.used + units <= chunk.units) {
        const offset = chunk.used;
        chunk.used += units;
        return new UniformSlot(this, chunk, offset, floats, units);
      }
    }
    const count = Math.max(units, Math.min(LAST_CHUNK, FIRST_CHUNK << Math.min(this.chunks.length, 8))),
      chunk: Chunk = {
        buffer: this.device.createBuffer({
          label: 'gltf-pro uniform arena',
          size: count * this.unit,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        cpu: new Float32Array((count * this.unit) / 4),
        used: units,
        live: 0,
        units: count,
        lo: Infinity,
        hi: 0,
        free: new Map(),
      };
    this.chunks.push(chunk);
    return new UniformSlot(this, chunk, 0, floats, units);
  }
  /**
   * Returns a slot. Callers go through `retire`, which defers this while commands that read the slot wait for submit,
   * exactly as it does for a buffer of its own. A chunk nothing uses any more goes back to the device.
   */
  free(slot: UniformSlot): void {
    const chunk = slot.chunk;
    chunk.live--;
    if (chunk.live === 0) {
      this.chunks.splice(this.chunks.indexOf(chunk), 1);
      chunk.buffer.destroy();
      return;
    }
    let free = chunk.free.get(slot.units);
    if (!free) chunk.free.set(slot.units, (free = []));
    free.push(slot.offset);
  }
}

const arenas = new WeakMap<GPUDevice, Arena>();
const arenaOf = (device: GPUDevice): Arena => {
  let arena = arenas.get(device);
  if (!arena) arenas.set(device, (arena = new Arena(device)));
  return arena;
};

/**
 * One draw's uniform block: a window `binding` of an arena chunk. `destroy()` returns it (after the current task, so
 * commands recorded but not yet submitted keep reading the values they were recorded with).
 */
export class UniformSlot {
  /** What a bind group binds. */
  readonly binding: GPUBufferBinding;
  /** The values the GPU holds for this slot once flushed. */
  private readonly shadow: Float32Array<ArrayBuffer>;
  private readonly start: number;
  private frame = 0;
  private view: object | undefined;
  private uses = 0;
  private extras: GPUBuffer[] = [];
  private gone = false;
  constructor(
    private readonly arena: Arena,
    readonly chunk: Chunk,
    readonly offset: number,
    readonly floats: number,
    readonly units: number,
  ) {
    chunk.live++;
    this.start = (offset * arena.unit) / 4;
    this.shadow = chunk.cpu.subarray(this.start, this.start + floats);
    this.binding = { buffer: chunk.buffer, offset: offset * arena.unit, size: floats * 4 };
  }
  /**
   * Stages `data` for a draw in `view`. The first write of a frame, and every write from that same view, go to the
   * slot itself and return undefined (uploaded by `flushUniforms`); a write with other values from another view of
   * the same frame (a second viewport, a probe face) goes to a reused copy whose binding is returned, so the earlier
   * view's draws keep their values.
   */
  write(data: Float32Array, view: object): GPUBufferBinding | undefined {
    const device = this.arena.device,
      now = currentFrame(device, view),
      shadow = this.shadow,
      length = this.floats;
    let same = this.frame === now && this.view !== view;
    for (let i = 0; same && i < length; i++) same = shadow[i] === data[i];
    if (this.frame !== now || this.view === view || same) {
      if (this.frame !== now) {
        this.frame = now;
        this.view = view;
        this.uses = 0;
      }
      let first = -1,
        last = -1;
      for (let i = 0; i < length; i++)
        if (!Object.is(shadow[i], data[i])) {
          shadow[i] = data[i];
          if (first < 0) first = i;
          last = i;
        }
      if (first >= 0) {
        const chunk = this.chunk;
        if (this.start + first < chunk.lo) chunk.lo = this.start + first;
        if (this.start + last + 1 > chunk.hi) chunk.hi = this.start + last + 1;
        this.arena.dirty = true;
      }
      return undefined;
    }
    const extra = (this.extras[this.uses++] ??= device.createBuffer({
      label: 'frame uniform copy',
      size: length * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(extra, 0, data as Float32Array<ArrayBuffer>);
    return { buffer: extra };
  }
  /** @internal The floats the GPU holds for this slot once the pending upload ran (tests read them). */
  get contents(): Float32Array {
    return this.shadow;
  }
  /** @internal True once `destroy()` returned the slot. */
  get destroyed(): boolean {
    return this.gone;
  }
  destroy(): void {
    if (this.gone) return;
    this.gone = true;
    for (const extra of this.extras) retire(this.arena.device, extra);
    this.extras = [];
    this.arena.free(this);
  }
}

/** A uniform block of `floats` floats on `device`. */
export function acquireUniform(device: GPUDevice, floats: number): UniformSlot {
  return arenaOf(device).allocate(floats);
}

/**
 * Uploads every changed uniform range of `device`'s arena, one `queue.writeBuffer` per chunk. Call it after the last
 * `UniformSlot.write` of a run of draws and before the frame is submitted.
 */
export function flushUniforms(device: GPUDevice): void {
  const arena = arenas.get(device);
  if (!arena?.dirty) return;
  // A write that throws leaves its range (and the flag) set, so the next flush uploads it again.
  for (const chunk of arena.chunks)
    if (chunk.lo < chunk.hi) {
      device.queue.writeBuffer(chunk.buffer, chunk.lo * 4, chunk.cpu, chunk.lo, chunk.hi - chunk.lo);
      chunk.lo = Infinity;
      chunk.hi = 0;
    }
  arena.dirty = false;
}
