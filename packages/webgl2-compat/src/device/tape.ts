// The recorded commands of an encoder or render bundle, as a tape (KB-COMPAT-FRAMEALLOC1, part 4). The code before made
// one closure per command (`ops.push((r) => r.draw(...))`), which holds its own context object and the arguments it
// captured: about 70 B a command, each frame, and an array copy of every bind group's dynamic offsets. A tape keeps an
// opcode per command in a Uint8Array, the numbers a command takes in a Float64Array and the objects it takes (a
// pipeline, a buffer, a bind group) in an array; Replayer.run reads them back with two cursors. A command that is rare
// or carries a closure of its own (a copy, a clear, a dispatch) is one CLOSURE opcode with the closure as its object.
// A command buffer's tape, the lists it uses and the pass descriptors it recorded return to the device's pool once the
// buffer has replayed (a command buffer submits once, so nothing reads them after), and the next encoder takes them.
import type { CompatDevice } from './device.js';
import type { CompatQuerySet, Replayer } from './render.js';
import type { CompatBindGroup, CompatTextureView, Usable, Uses } from './resources.js';

/** A command that is one closure (copies, clears, compute dispatches). */
export type Op = (r: Replayer) => void;

/** Opcodes: the numbers (N) and objects (O) each command takes, in the order Replayer.run reads them. */
export const OP = {
  /** O: the closure. */
  CLOSURE: 0,
  /** O: the pass snapshot. */
  BEGIN_PASS: 1,
  /** O: the pipeline. */
  SET_PIPELINE: 2,
  /** N: index, offset count, the offsets. O: the group (or null). */
  SET_BIND_GROUP: 3,
  /** N: slot, offset, size (-1 for none). O: the buffer (or null). */
  SET_VERTEX: 4,
  /** N: offset, size (-1 for none), the format (0 uint16, 1 uint32). O: the buffer. */
  SET_INDEX: 5,
  /** N: vertex count, instance count, first vertex, first instance. */
  DRAW: 6,
  /** N: index count, instance count, first index, base vertex, first instance. */
  DRAW_INDEXED: 7,
  /** N: offset. O: the buffer. */
  DRAW_INDIRECT: 8,
  /** N: offset. O: the buffer. */
  DRAW_INDEXED_INDIRECT: 9,
  /** N: x, y, width, height, min depth, max depth. */
  VIEWPORT: 10,
  /** N: x, y, width, height. */
  SCISSOR: 11,
  /** N: r, g, b, a. */
  BLEND_CONSTANT: 12,
  /** N: the reference. */
  STENCIL_REFERENCE: 13,
  /** N: the query index. */
  BEGIN_QUERY: 14,
  END_QUERY: 15,
  /** O: the list of bundles. */
  EXECUTE_BUNDLES: 16,
  END_PASS: 17,
  /** A compute pass begins: no pipeline, no bind groups. */
  COMPUTE_BEGIN: 18,
  /** O: the compute pipeline. */
  COMPUTE_PIPELINE: 19,
  /** As SET_BIND_GROUP, for the compute pass. */
  COMPUTE_BIND: 20,
  /** N: x, y, z workgroups. */
  DISPATCH: 21,
  /** N: offset. O: the buffer holding the three counts. */
  DISPATCH_INDIRECT: 22,
  /** N: source offset, destination offset, size. O: the source buffer, the destination buffer. */
  COPY_BUFFER: 23,
  /** N: source level, x, y, z, destination level, x, y, z, width, height, depth. O: the source texture, the destination. */
  COPY_TEXTURE: 24,
} as const;

/** One colour attachment as a pass records it; one object per slot of a pooled snapshot, reused every frame. */
export class ColorSnap {
  view!: CompatTextureView;
  depthSlice = 0;
  resolveTarget: CompatTextureView | undefined = undefined;
  readonly clearValue: number[] = [0, 0, 0, 0];
  loadOp!: GPULoadOp;
  storeOp!: GPUStoreOp;
}

/** A pass's depth and stencil attachment as it records it. */
export class DepthSnap {
  view!: CompatTextureView;
  depthClearValue = 0;
  depthLoadOp: GPULoadOp | undefined = undefined;
  depthStoreOp: GPUStoreOp | undefined = undefined;
  depthReadOnly = false;
  stencilClearValue = 0;
  stencilLoadOp: GPULoadOp | undefined = undefined;
  stencilStoreOp: GPUStoreOp | undefined = undefined;
  stencilReadOnly = false;
}

/** A render pass's descriptor, copied when the pass begins (callers may change theirs): the object a tape recycles. */
export class PassSnap {
  /** Exactly the pass's attachment count long, so the replay reads `colors.length` as WebGPU's count. */
  readonly colors: (ColorSnap | null)[];
  depth: DepthSnap | undefined = undefined;
  queries: CompatQuerySet | undefined = undefined;
  readonly slots: ColorSnap[] = [];
  readonly depthSlot = new DepthSnap();
  constructor(count: number) {
    this.colors = new Array<ColorSnap | null>(count).fill(null);
  }
  /** Drops the references to what the pass drew to, so a pooled snapshot keeps no texture alive. */
  clear(): void {
    for (let i = 0; i < this.colors.length; i++) {
      const slot = this.slots[i];
      if (slot) {
        (slot as { view: unknown }).view = undefined;
        slot.resolveTarget = undefined;
      }
      this.colors[i] = null;
    }
    (this.depthSlot as { view: unknown }).view = undefined;
    this.depth = undefined;
    this.queries = undefined;
  }
}

export class Tape {
  /** Where this tape goes once its command buffer has replayed (set when the pool hands it out). */
  pool: TapePool | null = null;
  codes = new Uint8Array(128);
  nums = new Float64Array(256);
  objs: unknown[] = [];
  /** Commands, numbers and objects recorded. */
  length = 0;
  nl = 0;
  ol = 0;
  /** What the commands use (see Uses); only the first `usesLength` entries count. */
  readonly uses: Uses = [];
  usesLength = 0;
  /**
   * Whether the compute pass being recorded has set a pipeline (a dispatch without one is a validation error). Kept here
   * and not on the pass encoder, which WebGPU hands back per pass: one field fewer on an object every frame makes.
   */
  computePipeline = false;
  /** Pass snapshots taken since the last reset, in order; the first `snapped` are in use. */
  private readonly snaps: PassSnap[] = [];
  private snapped = 0;

  /** Room for one more command and `numbers` more numbers. */
  private room(numbers: number): void {
    if (this.length === this.codes.length) {
      const grown = new Uint8Array(this.codes.length * 2);
      grown.set(this.codes);
      this.codes = grown;
    }
    if (this.nl + numbers > this.nums.length) {
      const grown = new Float64Array(Math.max(this.nums.length * 2, this.nl + numbers));
      grown.set(this.nums);
      this.nums = grown;
    }
  }
  /** A command with no numbers or objects. */
  op(code: number): void {
    this.room(0);
    this.codes[this.length++] = code;
  }
  /** A command with one object. */
  obj(code: number, o: unknown): void {
    this.room(0);
    this.codes[this.length++] = code;
    this.objs[this.ol++] = o;
  }
  /** A command with one number. */
  num(code: number, a: number): void {
    this.room(1);
    this.codes[this.length++] = code;
    this.nums[this.nl++] = a;
  }
  /** A command with two objects. */
  obj2(code: number, a: unknown, b: unknown): void {
    this.room(0);
    this.codes[this.length++] = code;
    this.objs[this.ol++] = a;
    this.objs[this.ol++] = b;
  }
  /** A command with four numbers. */
  n4(code: number, a: number, b: number, c: number, d: number): void {
    this.room(4);
    this.codes[this.length++] = code;
    const n = this.nums,
      at = this.nl;
    n[at] = a;
    n[at + 1] = b;
    n[at + 2] = c;
    n[at + 3] = d;
    this.nl = at + 4;
  }
  /** A command with three numbers. */
  n3(code: number, a: number, b: number, c: number): void {
    this.room(3);
    this.codes[this.length++] = code;
    const n = this.nums,
      at = this.nl;
    n[at] = a;
    n[at + 1] = b;
    n[at + 2] = c;
    this.nl = at + 3;
  }
  /** A command with five numbers. */
  n5(code: number, a: number, b: number, c: number, d: number, e: number): void {
    this.room(5);
    this.codes[this.length++] = code;
    const n = this.nums,
      at = this.nl;
    n[at] = a;
    n[at + 1] = b;
    n[at + 2] = c;
    n[at + 3] = d;
    n[at + 4] = e;
    this.nl = at + 5;
  }
  /** A command with six numbers. */
  n6(code: number, a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.room(6);
    this.codes[this.length++] = code;
    const n = this.nums,
      at = this.nl;
    n[at] = a;
    n[at + 1] = b;
    n[at + 2] = c;
    n[at + 3] = d;
    n[at + 4] = e;
    n[at + 5] = f;
    this.nl = at + 6;
  }
  /** A command with one object and one number. */
  objNum(code: number, o: unknown, a: number): void {
    this.room(1);
    this.codes[this.length++] = code;
    this.objs[this.ol++] = o;
    this.nums[this.nl++] = a;
  }
  /** An index buffer command. */
  indexBuffer(buffer: unknown, format: GPUIndexFormat, offset: number, size: number): void {
    this.room(3);
    this.codes[this.length++] = OP.SET_INDEX;
    this.objs[this.ol++] = buffer;
    const n = this.nums,
      at = this.nl;
    n[at] = offset;
    n[at + 1] = size;
    n[at + 2] = format === 'uint16' ? 0 : 1;
    this.nl = at + 3;
  }
  /** A command with one object and three numbers. */
  objNums3(code: number, o: unknown, a: number, b: number, c: number): void {
    this.room(3);
    this.codes[this.length++] = code;
    this.objs[this.ol++] = o;
    const n = this.nums,
      at = this.nl;
    n[at] = a;
    n[at + 1] = b;
    n[at + 2] = c;
    this.nl = at + 3;
  }
  /** A bind group command: the index, the dynamic offsets' count and values, then the group. */
  bindGroup(
    index: number,
    group: CompatBindGroup | null,
    offsets: ArrayLike<number> | undefined,
    start: number,
    count: number,
    code: number = OP.SET_BIND_GROUP,
  ): void {
    this.room(2 + count);
    this.codes[this.length++] = code;
    const n = this.nums;
    let at = this.nl;
    n[at++] = index;
    n[at++] = count;
    for (let i = 0; i < count; i++) n[at++] = (offsets as ArrayLike<number>)[start + i];
    this.nl = at;
    this.objs[this.ol++] = group;
  }
  /** A buffer to buffer copy. */
  copyBuffer(src: unknown, dst: unknown, srcOffset: number, dstOffset: number, size: number): void {
    this.room(3);
    this.codes[this.length++] = OP.COPY_BUFFER;
    this.objs[this.ol++] = src;
    this.objs[this.ol++] = dst;
    const n = this.nums,
      at = this.nl;
    n[at] = srcOffset;
    n[at + 1] = dstOffset;
    n[at + 2] = size;
    this.nl = at + 3;
  }
  /** A texture to texture copy: the regions as numbers, read from the descriptors' origins (an array or an object). */
  copyTextures(
    a: unknown,
    b: unknown,
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyTextureInfo,
    size: GPUExtent3D,
  ): void {
    this.room(11);
    this.codes[this.length++] = OP.COPY_TEXTURE;
    this.objs[this.ol++] = a;
    this.objs[this.ol++] = b;
    const n = this.nums;
    let at = this.nl;
    n[at++] = source.mipLevel ?? 0;
    at = this.origin(source.origin, at);
    n[at++] = destination.mipLevel ?? 0;
    at = this.origin(destination.origin, at);
    if (Array.isArray(size)) {
      n[at++] = size[0];
      n[at++] = size[1] ?? 1;
      n[at++] = size[2] ?? 1;
    } else {
      const d = size as GPUExtent3DDict;
      n[at++] = d.width;
      n[at++] = d.height ?? 1;
      n[at++] = d.depthOrArrayLayers ?? 1;
    }
    this.nl = at;
  }
  /** Writes an origin's three numbers at `at` and returns the next index. */
  private origin(o: GPUOrigin3D | undefined, at: number): number {
    const n = this.nums;
    if (!o) {
      n[at] = n[at + 1] = n[at + 2] = 0;
    } else if (Array.isArray(o)) {
      n[at] = o[0] ?? 0;
      n[at + 1] = o[1] ?? 0;
      n[at + 2] = o[2] ?? 0;
    } else {
      const d = o as GPUOrigin3DDict;
      n[at] = d.x ?? 0;
      n[at + 1] = d.y ?? 0;
      n[at + 2] = d.z ?? 0;
    }
    return at + 3;
  }
  /** A closure command (copies, clears, dispatches). */
  closure(fn: Op): void {
    this.obj(OP.CLOSURE, fn);
  }
  /** Records a resource the commands use. */
  use(u: Usable | readonly Usable[]): void {
    this.uses[this.usesLength++] = u;
  }

  /**
   * A pass snapshot of `count` colour attachments, recycled from an earlier use of this tape when it had the same
   * count (a frame repeats its passes), else new.
   */
  snapshot(count: number): PassSnap {
    let snap = this.snaps[this.snapped];
    if (!snap || snap.colors.length !== count) this.snaps[this.snapped] = snap = new PassSnap(count);
    this.snapped++;
    return snap;
  }

  /** Empties the tape for its next encoder, dropping every reference it held. */
  reset(): void {
    const objs = this.objs;
    for (let i = 0; i < this.ol; i++) objs[i] = undefined;
    const uses = this.uses as unknown[];
    for (let i = 0; i < this.usesLength; i++) uses[i] = undefined;
    for (let i = 0; i < this.snapped; i++) this.snaps[i].clear();
    this.length = this.nl = this.ol = this.usesLength = this.snapped = 0;
    this.computePipeline = false;
  }
}

/** The device's tapes waiting for their next encoder. */
export class TapePool {
  private readonly free: Tape[] = [];
  private count = 0;
  /**
   * The device the tapes record for: an encoder reaches it through its tape (`tape.pool.device`) to report errors, so
   * the encoders and pass encoders WebGPU hands back each call carry no field of their own for it.
   */
  constructor(readonly device: CompatDevice) {}
  take(): Tape {
    const tape = this.count > 0 ? this.free[--this.count] : new Tape();
    tape.pool = this;
    return tape;
  }
  /** `tape` is empty and ready again (nothing reads it after a command buffer's replay). */
  give(tape: Tape): void {
    tape.reset();
    this.free[this.count++] = tape;
  }
}
