// The layer's storage for imported video frames. WebGPU expires an external texture when the task that imported it
// ends (a VideoFrame's also when it closes); the browser owns the storage behind it. WebGL2 has no zero-copy video, so
// the layer copies each import into a texture of its own, which follows the same lifetime: it serves its source for the
// rest of the task, then returns to a few spares that the next import of the same size reuses. A steady video therefore
// allocates nothing per frame, and no copy outlives its importer by more than one task plus SPARE_EXTERNALS spares.

/** Spare copies kept per device for the next frames; the oldest beyond this are destroyed. */
export const SPARE_EXTERNALS = 2;

interface Copy {
  readonly width: number;
  readonly height: number;
  destroy(): void;
}

/** One device's external-texture copies: those serving the current task, and the spares the next imports reuse. */
export class ExternalCopies<T extends Copy> {
  /** This task's copies, per imported source; emptied when the task ends. */
  private readonly current = new Map<object, T>();
  /** Expired copies, oldest first, waiting to be reused. */
  private readonly spares: T[] = [];
  private scheduled = false;

  constructor(
    private readonly make: (width: number, height: number) => T,
    private readonly afterTask: (end: () => void) => void,
  ) {}

  /** The copy that serves `source` (width by height) until the current task ends. */
  take(source: object, width: number, height: number): T {
    const held = this.current.get(source);
    if (held && held.width === width && held.height === height) return held;
    if (held) {
      this.current.delete(source);
      this.spare(held);
    }
    const i = this.spares.findIndex((t) => t.width === width && t.height === height);
    const copy = i < 0 ? this.make(width, height) : this.spares.splice(i, 1)[0];
    this.current.set(source, copy);
    if (!this.scheduled) {
      this.scheduled = true;
      this.afterTask(() => this.expire());
    }
    return copy;
  }

  /** Copies alive now: the current task's and the spares. */
  get size(): number {
    return this.current.size + this.spares.length;
  }

  /** Ends the task: every current copy expires into the spares. */
  expire(): void {
    this.scheduled = false;
    for (const copy of this.current.values()) this.spare(copy);
    this.current.clear();
  }

  /** Destroys every copy (the device is destroyed). */
  destroy(): void {
    for (const copy of this.current.values()) copy.destroy();
    for (const copy of this.spares) copy.destroy();
    this.current.clear();
    this.spares.length = 0;
  }

  private spare(copy: T): void {
    this.spares.push(copy);
    while (this.spares.length > SPARE_EXTERNALS) this.spares.shift()!.destroy();
  }
}
