/// <reference lib="esnext.disposable" preserve="true" />
declare const GPUBufferUsage: { QUERY_RESOLVE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
// Match BigUint64Array's native byte order without creating BigInts per query.
const lowWord = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1,
  highWord = 1 - lowWord,
  wordRange = 0x100000000;

/** Sums pass durations in milliseconds; one asynchronous readback can be in flight. */
export class GPUProfiler {
  readonly supported: boolean;
  milliseconds: number | null = null;
  /** Reused storage for the latest complete sample, in timestampWrites() order. */
  readonly passMilliseconds = new Float64Array(128);
  passCount = 0;
  /** First pass beginning to last pass end, including intervening commands and gaps. */
  elapsedMilliseconds: number | null = null;
  private query?: GPUQuerySet;
  private resolveBuffer?: GPUBuffer;
  private readBuffer?: GPUBuffer;
  private readonly descriptors: GPURenderPassTimestampWrites[] = [];
  private count = 0;
  private overflow = false;
  private state: 'idle' | 'recording' | 'resolved' | 'reading' | 'disposed' = 'idle';
  private disposed = false;

  constructor(device: GPUDevice) {
    this.supported = device.features.has('timestamp-query');
    if (!this.supported) return;
    try {
      this.query = device.createQuerySet({ type: 'timestamp', count: 256 });
      this.resolveBuffer = device.createBuffer({
        size: 2048,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.readBuffer = device.createBuffer({ size: 2048, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      for (let i = 0; i < 128; i++)
        this.descriptors.push({
          querySet: this.query,
          beginningOfPassWriteIndex: i * 2,
          endOfPassWriteIndex: i * 2 + 1,
        });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  beginFrame(): boolean {
    if (this.state === 'disposed') throw new Error('GPU profiler is disposed');
    if (!this.supported || this.state !== 'idle') return false;
    this.count = 0;
    this.overflow = false;
    this.state = 'recording';
    return true;
  }

  timestampWrites(): GPURenderPassTimestampWrites | undefined {
    if (this.state !== 'recording') return;
    // shortcut: 128 passes per sample, raise query capacity for larger frame graphs.
    if (this.count === this.descriptors.length) {
      this.overflow = true;
      return;
    }
    return this.descriptors[this.count++];
  }

  resolve(encoder: GPUCommandEncoder): boolean {
    if (this.state !== 'recording') return false;
    if (!this.count || this.overflow) {
      this.clearSample();
      this.state = 'idle';
      return false;
    }
    encoder.resolveQuerySet(this.query!, 0, this.count * 2, this.resolveBuffer!, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer!, 0, this.readBuffer!, 0, this.count * 16);
    this.state = 'resolved';
    return true;
  }

  /** Call after submitting the command buffer containing resolve(). */
  async read(): Promise<number | null> {
    if (this.state !== 'resolved') return null;
    this.state = 'reading';
    const buffer = this.readBuffer!;
    try {
      await buffer.mapAsync(GPUMapMode.READ, 0, this.count * 16);
      if (this.disposed) return null;
      const timestamps = new Uint32Array(buffer.getMappedRange(0, this.count * 16));
      let totalLow = 0,
        totalHigh = 0,
        previousLow = 0,
        previousHigh = 0;
      for (let i = 0; i < timestamps.length; i += 4) {
        const startLow = timestamps[i + lowWord],
          startHigh = timestamps[i + highWord],
          endLow = timestamps[i + 2 + lowWord],
          endHigh = timestamps[i + 2 + highWord];
        if (
          endHigh < startHigh ||
          (endHigh === startHigh && endLow < startLow) ||
          (i > 0 && (startHigh < previousHigh || (startHigh === previousHigh && startLow < previousLow)))
        )
          throw new Error('Invalid GPU timestamps');
        let low = endLow - startLow,
          high = endHigh - startHigh;
        if (low < 0) {
          low += wordRange;
          high--;
        }
        totalLow += low;
        totalHigh += high;
        if (totalLow >= wordRange) {
          totalLow -= wordRange;
          totalHigh++;
        }
        previousLow = endLow;
        previousHigh = endHigh;
      }
      // Validate the whole readback before replacing a previously completed sample.
      for (let i = 0; i < this.count; i++) {
        let low = timestamps[i * 4 + 2 + lowWord] - timestamps[i * 4 + lowWord],
          high = timestamps[i * 4 + 2 + highWord] - timestamps[i * 4 + highWord];
        if (low < 0) {
          low += wordRange;
          high--;
        }
        this.passMilliseconds[i] = (high * wordRange + low) / 1e6;
      }
      this.passMilliseconds.fill(0, this.count);
      this.passCount = this.count;
      let elapsedLow = previousLow - timestamps[lowWord],
        elapsedHigh = previousHigh - timestamps[highWord];
      if (elapsedLow < 0) {
        elapsedLow += wordRange;
        elapsedHigh--;
      }
      this.elapsedMilliseconds = (elapsedHigh * wordRange + elapsedLow) / 1e6;
      return (this.milliseconds = (totalHigh * wordRange + totalLow) / 1e6);
    } catch (error) {
      this.clearSample();
      if (!this.disposed) throw error;
      return null;
    } finally {
      if (!this.disposed) {
        buffer.unmap();
        this.state = 'idle';
      }
    }
  }

  private clearSample(): void {
    this.milliseconds = this.elapsedMilliseconds = null;
    this.passCount = 0;
    this.passMilliseconds.fill(0);
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.disposed = true;
    this.state = 'disposed';
    this.query?.destroy();
    this.resolveBuffer?.destroy();
    this.readBuffer?.destroy();
    this.query = this.resolveBuffer = this.readBuffer = undefined;
    this.clearSample();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
