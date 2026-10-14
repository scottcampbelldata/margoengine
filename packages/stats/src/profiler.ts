declare const GPUBufferUsage: {QUERY_RESOLVE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number};
declare const GPUMapMode: {READ: number};

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
      this.query = device.createQuerySet({type: 'timestamp', count: 256});
      this.resolveBuffer = device.createBuffer({size: 2048, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      this.readBuffer = device.createBuffer({size: 2048, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      for (let i = 0; i < 128; i++) this.descriptors.push({querySet: this.query, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1});
    } catch (error) {this.dispose(); throw error;}
  }

  beginFrame(): boolean {
    if (this.state === 'disposed') throw new Error('GPU profiler is disposed');
    if (!this.supported || this.state !== 'idle') return false;
    this.count = 0; this.overflow = false; this.state = 'recording'; return true;
  }

  timestampWrites(): GPURenderPassTimestampWrites | undefined {
    if (this.state !== 'recording') return;
    // shortcut: 128 passes per sample, raise query capacity for larger frame graphs.
    if (this.count === this.descriptors.length) {this.overflow = true; return;}
    return this.descriptors[this.count++];
  }

  resolve(encoder: GPUCommandEncoder): boolean {
    if (this.state !== 'recording') return false;
    if (!this.count || this.overflow) {this.clearSample(); this.state = 'idle'; return false;}
    encoder.resolveQuerySet(this.query!, 0, this.count * 2, this.resolveBuffer!, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer!, 0, this.readBuffer!, 0, this.count * 16);
    this.state = 'resolved'; return true;
  }

  /** Call after submitting the command buffer containing resolve(). */
  async read(): Promise<number | null> {
    if (this.state !== 'resolved') return null;
    this.state = 'reading';
    const buffer = this.readBuffer!;
    try {
      await buffer.mapAsync(GPUMapMode.READ, 0, this.count * 16);
      if (this.disposed) return null;
      const timestamps = new BigUint64Array(buffer.getMappedRange(0, this.count * 16));
      let total = 0n;
      for (let i = 0; i < timestamps.length; i += 2) {
        if (timestamps[i + 1] < timestamps[i] || i > 0 && timestamps[i] < timestamps[i - 1]) throw new Error('Invalid GPU timestamps');
        total += timestamps[i + 1] - timestamps[i];
      }
      // Validate the whole readback before replacing a previously completed sample.
      for (let i = 0; i < this.count; i++) this.passMilliseconds[i] = Number(timestamps[i * 2 + 1] - timestamps[i * 2]) / 1e6;
      this.passMilliseconds.fill(0, this.count); this.passCount = this.count;
      this.elapsedMilliseconds = Number(timestamps[timestamps.length - 1] - timestamps[0]) / 1e6;
      return this.milliseconds = Number(total) / 1e6;
    } catch (error) {this.clearSample(); if (!this.disposed) throw error; return null;}
    finally {if (!this.disposed) {buffer.unmap(); this.state = 'idle';}}
  }

  private clearSample(): void {this.milliseconds = this.elapsedMilliseconds = null; this.passCount = 0; this.passMilliseconds.fill(0);}

  dispose(): void {
    if (this.state === 'disposed') return;
    this.disposed = true; this.state = 'disposed'; this.query?.destroy(); this.resolveBuffer?.destroy(); this.readBuffer?.destroy();
    this.query = this.resolveBuffer = this.readBuffer = undefined; this.clearSample();
  }
}
