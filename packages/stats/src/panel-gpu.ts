import { GPUProfiler } from './profiler.js';
import type { GLPassTime } from './gl.js';

/** Internal timestamp owner keeping names and results in the same completed sample. */
export class PanelGPU {
  private readonly profiler: GPUProfiler;
  private readonly tracked = new WeakSet<GPUCommandEncoder>();
  private frame = 0;
  private disposed = false;
  constructor(
    device: GPUDevice,
    private readonly complete: (milliseconds: number | null, passes: GLPassTime[]) => void,
    private readonly error: (error: unknown) => void,
  ) {
    this.profiler = new GPUProfiler(device);
  }
  get supported(): boolean {
    return this.profiler.supported;
  }
  track(encoder: GPUCommandEncoder): void {
    if (this.disposed || this.tracked.has(encoder)) return;
    this.tracked.add(encoder);
    if (++this.frame % 15 !== 0 || !this.profiler.beginFrame()) return;
    const names: string[] = [],
      profiler = this.profiler;
    const render = encoder.beginRenderPass,
      compute = encoder.beginComputePass,
      finish = encoder.finish;
    encoder.beginRenderPass = (descriptor) => {
      const writes = descriptor.timestampWrites ? undefined : profiler.timestampWrites();
      if (writes) names.push(descriptor.label || `render ${names.length + 1}`);
      return render.call(encoder, writes ? { ...descriptor, timestampWrites: writes } : descriptor);
    };
    encoder.beginComputePass = (descriptor = {}) => {
      const writes = descriptor.timestampWrites ? undefined : profiler.timestampWrites();
      if (writes) names.push(descriptor.label || `compute ${names.length + 1}`);
      return compute.call(encoder, writes ? { ...descriptor, timestampWrites: writes } : descriptor);
    };
    encoder.finish = (descriptor) => {
      const resolved = profiler.resolve(encoder),
        result = finish.call(encoder, descriptor);
      if (!resolved) {
        if (profiler.milliseconds === null) this.complete(null, []);
        return result;
      }
      queueMicrotask(() => {
        void profiler.read().then(
          (value) => {
            if (this.disposed) return;
            this.complete(
              value,
              value === null
                ? []
                : names
                    .slice(0, profiler.passCount)
                    .map((name, i) => ({ name, milliseconds: profiler.passMilliseconds[i] })),
            );
          },
          (error) => {
            if (!this.disposed) {
              this.complete(null, []);
              this.error(error);
            }
          },
        );
      });
      return result;
    };
  }
  dispose(): void {
    this.disposed = true;
    this.profiler.dispose();
  }
}
